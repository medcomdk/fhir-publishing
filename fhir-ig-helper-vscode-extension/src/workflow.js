const fs = require('node:fs/promises');
const path = require('node:path');
const { readConfig } = require('./config');
const { createCommandRunner } = require('./commands');
const { checkTools, prepareFirely } = require('./firely');
const { validateResources } = require('./resources');

async function validateIg({
  configPath,
  firelyPath = 'fhir',
  sushiPath = 'sushi',
  runSushi = true,
  deleteOutput = false,
  signal,
  log = () => {},
  progress = () => {},
  onResult = () => {},
  run,
}) {
  const root = path.dirname(configPath);
  const config = readConfig(await fs.readFile(configPath, 'utf8'));
  const commands = createCommandRunner({ cwd: root, signal, log, run });

  if (deleteOutput) {
    const outputDirectory = path.join(root, 'output');
    progress('Removing publisher output');
    await fs.rm(outputDirectory, { recursive: true, force: true });
    log(`\nRemoved publisher output at ${outputDirectory}.\n`);
  }

  progress(`Checking ${runSushi ? 'SUSHI and ' : ''}Firely Terminal`);
  const tools = await checkTools({
    commands, firelyPath, sushiPath, runSushi,
  });

  progress(`Preparing Firely ${config.spec.toUpperCase()} packages`);
  const warnings = await prepareFirely({ root, config, commands, firelyPath: tools.firelyPath, log });

  if (runSushi) {
    progress('Building the implementation guide with SUSHI');
    await commands.runRequiredCommand(tools.sushiPath, ['.']);
  } else {
    log('\nSkipped SUSHI; validating the existing fsh-generated resources.\n');
  }

  const results = await validateResources({
    root, commands, firelyPath: tools.firelyPath, validationFlags: tools.validationFlags,
    runSushi, signal, log, progress, onResult,
  });
  const summary = { ...results, warnings: [...warnings, ...results.warnings] };
  log(`\nValidated: ${summary.validated}\nPassed: ${summary.passed}\nFailed: ${summary.failed}\nSkipped: ${summary.skipped}\n`);
  return summary;
}

module.exports = { validateIg };
