const fs = require('node:fs/promises');
const path = require('node:path');
const { checkCancelled } = require('./process');
const { locateFirelyIssues } = require('./locations');

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const FAILURE_FINDING = /^\s*(?:Result:\s*INVALID\b|(?:Error|Fatal)\s*:)/im;

function plainOutput(text) {
  return text.replace(ANSI_ESCAPE, '').trim();
}

function validationPassed(result) {
  // Firely 3.5.0 can exit 0 with "Result: INVALID" without --fail.
  return result.code === 0 && !FAILURE_FINDING.test(plainOutput(result.output));
}

async function findResourceFiles(root, runSushi) {
  const directory = path.join(root, 'fsh-generated', 'resources');
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' && runSushi === false) {
      throw new Error(
        'No generated FHIR resources were found. Run validation again with "Run SUSHI" selected, ' +
        'or run SUSHI manually before validating without a build.',
        { cause: error },
      );
    }
    throw new Error(`Cannot read generated resources at ${directory}: ${error.message}`, { cause: error });
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
  if (files.length === 0) {
    if (runSushi === false) {
      throw new Error(
        'No generated FHIR resources were found. Run validation again with "Run SUSHI" selected, ' +
        'or run SUSHI manually before validating without a build.',
      );
    }
    throw new Error(`SUSHI generated no JSON resources in ${directory}.`);
  }
  return files;
}

function skipReason(resource) {
  const type = resource?.resourceType;
  if (typeof type !== 'string' || !type) {
    return 'no resourceType';
  }
  if (type !== 'Bundle') {
    return type;
  }
  return undefined;
}

async function validateResource(file, options) {
  const { root, commands, firelyPath, validationFlags, progress } = options;
  checkCancelled(options.signal);
  let resource;
  let source;
  try {
    source = await fs.readFile(file, 'utf8');
    resource = JSON.parse(source);
  } catch (error) {
    return { file, status: 'failed', output: `Cannot read resource JSON: ${error.message}` };
  }
  const reason = skipReason(resource);
  if (reason) {
    return { file, status: 'skipped', reason };
  }

  progress(`Validating ${path.basename(file)}`);
  // Firely expects project-relative patterns, including on Windows.
  const relativeFile = path.relative(root, file).split(path.sep).join('/');
  const result = await commands.runCommand(
    firelyPath, ['validate', relativeFile, ...validationFlags], { streamOutput: false },
  );
  return {
    file,
    status: validationPassed(result) ? 'passed' : 'failed',
    code: result.code,
    output: plainOutput(result.output) || `Firely exited with status ${result.code}.`,
    findings: locateFirelyIssues(source, resource.resourceType, plainOutput(result.output)),
  };
}

function reportResource(result, log, onResult) {
  const name = path.basename(result.file);
  if (result.status === 'skipped' || result.status === 'cancelled') {
    log(`${result.status}: ${name}: ${result.reason || 'Validation cancelled'}.\n`);
    return;
  }
  const exitCode = result.code === undefined ? '' : ` (exit ${result.code})`;
  log(`\n${result.status.toUpperCase()} ${name}${exitCode}\n${result.output}\n`);
  onResult({
    file: result.file,
    passed: result.status === 'passed',
    output: result.output,
    findings: result.findings,
  });
}

function summarizeResults(results) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const { status } of results) counts[status]++;
  const validated = counts.passed + counts.failed;
  const warnings = validated === 0
    ? ['No Bundles were validated; all generated resources were skipped.']
    : [];
  return { validated, ...counts, warnings };
}

async function validateResources(options) {
  const { root, log, onResult } = options;
  const files = await findResourceFiles(root, options.runSushi);
  // Start every check concurrently and drain every process before restoring manifests.
  const settled = await Promise.allSettled(files.map((file) => validateResource(file, options)));
  const results = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    return {
      file: files[index],
      status: result.reason.name === 'AbortError' ? 'cancelled' : 'failed',
      output: result.reason.message,
    };
  });
  for (const result of results) reportResource(result, log, onResult);
  checkCancelled(options.signal);
  return summarizeResults(results);
}

module.exports = { findResourceFiles, validateResources, plainOutput, validationPassed };
