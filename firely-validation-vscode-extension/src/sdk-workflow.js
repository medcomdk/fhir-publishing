const fs = require('node:fs/promises');
const path = require('node:path');
const { readConfig } = require('./config');
const { createCommandRunner } = require('./commands');
const { validateResources } = require('./sdk-resources');

async function requireSdkPackage(root, runGenonce = false) {
  const packagePath = path.join(root, 'output', 'package.tgz');
  try {
    if (!(await fs.stat(packagePath)).isFile()) throw new Error('Not a file');
  } catch (error) {
    throw new Error(runGenonce
      ? `_genonce.sh did not create "${packagePath}". See Firely output for build details.`
      : `SDK validation cannot start because the IG package was not found at "${packagePath}". ` +
        '"Run _genonce.sh" was not selected, so no package was built. ' +
        'Run "Validate with SDK" again and select "Run _genonce.sh", or build the package manually first.', { cause: error });
  }
  return packagePath;
}

async function validateIgWithSdk({
  configPath,
  workspaceRoot = path.dirname(configPath),
  dotnetPath = 'dotnet',
  runGenonce = true,
  terminologyServer = 'https://tx.hl7europe.eu/r4',
  signal,
  log = () => {},
  progress = () => {},
  onResult = () => {},
  run,
}) {
  const root = workspaceRoot;
  const config = readConfig(await fs.readFile(configPath, 'utf8'));
  if (config.spec !== 'r4') throw new Error('The SDK validator supports FHIR R4 (4.0.x) only.');
  if (!runGenonce) await requireSdkPackage(root);
  const commands = createCommandRunner({ cwd: root, signal, log, run });
  progress('Checking .NET SDK');
  await commands.runRequiredCommand(dotnetPath, ['--version']);

  const packagePath = path.join(root, 'output', 'package.tgz');
  if (runGenonce) {
    const script = path.join(root, '_genonce.sh');
    try {
      if (!(await fs.stat(script)).isFile()) throw new Error('Not a file');
    } catch (error) {
      throw new Error(`Cannot read ${script}. Add _genonce.sh to the open workspace folder, or clear "Run _genonce.sh" to use an existing package.`, { cause: error });
    }
    // A requested rebuild must produce a new package, even if the script exits 0.
    await fs.rm(packagePath, { force: true });
    progress('Rebuilding the implementation guide with _genonce.sh');
    await commands.runRequiredCommand('bash', ['./_genonce.sh'], { processGroup: true });
  } else {
    log('\nSkipped _genonce.sh; using the existing package and published Bundles in output.\n');
  }
  await requireSdkPackage(root, runGenonce);

  log(`\nValidating with profiles from ${packagePath}.\n`);
  const summary = await validateResources({
    root, commands, dotnetPath, packagePath, terminologyServer,
    signal, log, progress, onResult,
  });
  log(`\nValidated: ${summary.validated}\nPassed: ${summary.passed}\nFailed: ${summary.failed}\nSkipped: ${summary.skipped}\n`);
  return summary;
}

module.exports = { validateIgWithSdk, requireSdkPackage };
