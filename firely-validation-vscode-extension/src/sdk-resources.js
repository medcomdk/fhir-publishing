const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { checkCancelled } = require('./process');
const { locateFirelyIssues, extractFirelyIssues } = require('./locations');

async function findPublishedBundles(root) {
  const directory = path.join(root, 'output');
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read published Bundles at "${directory}". Run _genonce.sh before SDK validation.`, { cause: error });
  }
  const files = entries.filter(entry => entry.isFile() && /^Bundle-.+\.(json|xml)$/i.test(entry.name));
  if (files.length === 0) {
    throw new Error(`No published Bundle JSON or XML files were found in "${directory}". Run _genonce.sh to generate them before SDK validation.`);
  }
  return files.map(entry => path.join(directory, entry.name)).sort();
}

async function validateResources(options) {
  const { root, commands, dotnetPath, packagePath, terminologyServer, log, onResult, progress } = options;
  await findPublishedBundles(root);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'firely-sdk-'));
  const report = path.join(temporary, 'report.json');
  try {
    progress('Validating Bundles with the Firely .NET SDK');
    const result = await commands.runCommand(dotnetPath, [
      'run', '--project', path.resolve(__dirname, '../validator/FirelyValidator.csproj'),
      '--configuration', 'Release', '--', packagePath,
      '--resources', path.join(root, 'output'),
      '--resource-type', 'Bundle', '--terminology-server', terminologyServer,
      '--report', report,
    ], { processGroup: true });
    checkCancelled(options.signal);
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`SDK validation could not complete (exit ${result.code}). See Firely output for details.`);
    }
    let summary;
    try {
      summary = JSON.parse(await fs.readFile(report, 'utf8'));
    } catch (error) {
      throw new Error('The SDK validator did not produce a validation report. See Firely output for details.', { cause: error });
    }
    if (!Array.isArray(summary.results) || !Array.isArray(summary.warnings) ||
        !['validated', 'passed', 'failed', 'skipped'].every((key) => Number.isInteger(summary[key]) && summary[key] >= 0) ||
        (result.code === 1) !== (summary.failed > 0)) {
      throw new Error('The SDK validation report is incomplete or inconsistent with its exit code.');
    }
    for (const resource of summary.results) {
      if (resource.status === 'skipped') continue;
      const source = await fs.readFile(resource.file, 'utf8');
      let resourceType;
      try { resourceType = JSON.parse(source).resourceType; } catch { /* Report malformed JSON at the start of the file. */ }
      onResult({
        file: resource.file,
        passed: resource.status === 'passed',
        output: resource.output,
        findings: path.extname(resource.file).toLowerCase() === '.xml'
          ? extractFirelyIssues(resource.output)
          : locateFirelyIssues(source, resourceType, resource.output),
      });
    }
    for (const warning of summary.warnings) log(`Warning: ${warning}\n`);
    const { results, ...counts } = summary;
    return counts;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = { validateResources, findPublishedBundles };
