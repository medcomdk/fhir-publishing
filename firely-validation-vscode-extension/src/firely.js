const fs = require('node:fs/promises');
const path = require('node:path');
const { isMapping } = require('./config');

const CORE_PACKAGE_PATTERN = /^hl7\.fhir\.r[^.]*\.core$/i;

async function checkTools(options) {
  const { commands, firelyPath, sushiPath } = options;
  await commands.runRequiredCommand(firelyPath, ['--version']);
  if (options.runSushi !== false) {
    await commands.runRequiredCommand(sushiPath, ['--version']);
  }
  const help = await commands.runRequiredCommand(firelyPath, ['?', 'validate']);
  const validationFlags = help.output.includes('--fail') ? ['--fail'] : [];
  return { firelyPath, sushiPath, validationFlags };
}

function withoutCorePackage(dependencies) {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([id]) => !CORE_PACKAGE_PATTERN.test(id)),
  );
}

function packageMatchesConfig(manifest, config) {
  if (!isMapping(manifest) || !isMapping(manifest.dependencies)) return false;

  const packageDependencies = withoutCorePackage(manifest.dependencies);
  const sushiDependencies = withoutCorePackage(config.dependencies);
  const packageIds = Object.keys(packageDependencies);
  const sushiIds = Object.keys(sushiDependencies);

  return packageIds.length === sushiIds.length && sushiIds.every((id) =>
    Object.hasOwn(packageDependencies, id) && packageDependencies[id] === sushiDependencies[id]);
}

function isIgnorableCircularDependencyRestore(result) {
  return result.code === 255 && /outdated/i.test(result.output) && /circular/i.test(result.output);
}

function logCapturedOutput(result, log) {
  if (result.output) log(result.output);
}

async function readPackage(packagePath) {
  try {
    const stat = await fs.lstat(packagePath);
    if (!stat.isFile()) {
      throw new Error(`Cannot update ${packagePath}: it is not a regular file.`);
    }
    return JSON.parse(await fs.readFile(packagePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writePackageDependencies(packagePath, manifest, sushiDependencies) {
  if (!isMapping(manifest)) {
    throw new Error(`${packagePath} must contain a JSON object.`);
  }
  const packageDependencies = isMapping(manifest.dependencies) ? manifest.dependencies : {};
  const coreDependencies = Object.fromEntries(
    Object.entries(packageDependencies).filter(([id]) => CORE_PACKAGE_PATTERN.test(id)),
  );
  const updatedManifest = {
    ...manifest,
    dependencies: { ...coreDependencies, ...withoutCorePackage(sushiDependencies) },
  };
  await fs.writeFile(packagePath, JSON.stringify(updatedManifest, null, 2) + '\n');
}

async function hasRestoredPackages(root, commands, firelyPath) {
  let lock;
  try {
    lock = JSON.parse(await fs.readFile(path.join(root, 'fhirpkg.lock.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }

  if (!isMapping(lock) || !isMapping(lock.dependencies) ||
      (isMapping(lock.missing) && Object.keys(lock.missing).length > 0)) {
    return false;
  }
  const lockedPackages = Object.entries(lock.dependencies);
  if (lockedPackages.length === 0 || lockedPackages.some(([, version]) => typeof version !== 'string')) {
    return false;
  }

  const cache = await commands.runCommand(firelyPath, ['cache', 'list'], { streamOutput: false });
  if (cache.code !== 0) return false;
  const cachedPackages = new Set(cache.output.split(/\r?\n/).map((line) => line.trim().toLowerCase()));
  return lockedPackages.every(([id, version]) => cachedPackages.has(`${id}@${version}`.toLowerCase()));
}

async function prepareFirely({ root, config, commands, firelyPath, log }) {
  await commands.runRequiredCommand(firelyPath, ['spec', config.spec]);

  const packagePath = path.join(root, 'package.json');
  let manifest = await readPackage(packagePath);
  const packageWasMissing = manifest === undefined;

  if (packageWasMissing) {
    await commands.runRequiredCommand(firelyPath, ['init', config.name, config.version]);
    manifest = await readPackage(packagePath);
    if (manifest === undefined) {
      throw new Error('fhir init did not create package.json.');
    }
  } else if (packageMatchesConfig(manifest, config)) {
    // `fhir scope` only prints the lock-file closure and can succeed when its
    // packages are absent. Compare the closure with the actual cache instead.
    if (await hasRestoredPackages(root, commands, firelyPath)) {
      log('\nFirely dependencies are unchanged and available; skipping fhir init and fhir restore.\n');
      return [];
    }
    log('\nFirely dependencies are unchanged but are not restored in this environment.\n');
  }

  await writePackageDependencies(packagePath, manifest, config.dependencies);
  const restore = await commands.runCommand(firelyPath, ['restore'], { streamOutput: false });

  if (restore.code === 0 || isIgnorableCircularDependencyRestore(restore)) {
    if (restore.code === 0) logCapturedOutput(restore, log);
    return [];
  }
  logCapturedOutput(restore, log);
  const warning = `Firely package restore exited with status ${restore.code}; ` +
    'Validation may be incomplete.';
  log(`\nWarning: ${warning}\n`);
  return [warning];
}

module.exports = {
  checkTools, hasRestoredPackages, isIgnorableCircularDependencyRestore, packageMatchesConfig,
  prepareFirely,
};
