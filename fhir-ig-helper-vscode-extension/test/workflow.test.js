const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateIg } = require('../src/workflow');
const { readConfig } = require('../src/config');
const { validationPassed } = require('../src/resources');
const { runProcess } = require('../src/process');

const yaml = `id: example.ig
version: 1.2.3
fhirVersion: 4.0.1
description: Example IG
dependencies:
  example.base: 2.0.0
  example.extended:
    version: 3.0.0
`;

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'firely test with spaces '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'sushi-config.yaml');
  await fs.writeFile(configPath, yaml);
  const calls = [];
  let packagesAvailable = options.packagesAvailable ?? false;
  const run = async (exe, args, processOptions) => {
    calls.push([exe, ...args]);
    assert.equal(processOptions.cwd, root);
    const command = args[0];
    if (options.hook) {
      const result = await options.hook(exe, args, processOptions);
      if (result) {
        if (command === 'restore' &&
            (result.code === 0 || (result.code === 255 && /outdated/i.test(result.output) && /circular/i.test(result.output)))) {
          packagesAvailable = true;
        }
        return result;
      }
    }
    if (command === 'init') {
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: args[1],
        version: args[2],
        fhirVersions: ['4.0.1'],
        dependencies: { 'hl7.fhir.r4.core': '4.0.1', 'example.base': '1.0.0' },
      }));
      await fs.writeFile(path.join(root, 'fhirpkg.lock.json'), JSON.stringify({
        dependencies: {
          'hl7.fhir.r4.core': '4.0.1',
          'example.base': '2.0.0',
          'example.extended': '3.0.0',
        },
        missing: {},
      }));
    }
    if (command === 'restore') {
      const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
      const currentConfig = readConfig(await fs.readFile(configPath, 'utf8'));
      assert.deepEqual(manifest.dependencies,
        { 'hl7.fhir.r4.core': '4.0.1', ...currentConfig.dependencies });
      packagesAvailable = true;
    }
    if (command === '.') {
      const resources = path.join(root, 'fsh-generated', 'resources');
      await fs.mkdir(resources, { recursive: true });
      const files = options.files ?? {
        'Bundle-good.json': { resourceType: 'Bundle', id: 'good', type: 'collection' },
        'Bundle-bad.json': { resourceType: 'Bundle', id: 'bad', type: 'collection' },
        'Patient.json': { resourceType: 'Patient', id: 'patient' },
        'metadata.json': {},
      };
      for (const [name, value] of Object.entries(files)) {
        await fs.writeFile(path.join(resources, name), typeof value === 'string' ? value : JSON.stringify(value));
      }
    }
    if (command === '--list-sdks') return { code: 0, output: '8.0.418 [/dotnet/sdk]' };
    if (command === 'cache') return packagesAvailable
      ? { code: 0, output: 'hl7.fhir.r4.core@4.0.1\nexample.base@2.0.0\nexample.extended@3.0.0\n' }
      : { code: 0, output: 'hl7.fhir.r4.core@4.0.1\n' };
    if (command === '?') return { code: 0, output: 'validate <file> --fail' };
    if (command === 'validate' && args[1].endsWith('Bundle-bad.json')) return { code: 0, output: '\x1b[31mResult: INVALID\x1b[0m' };
    return { code: 0, output: 'OK' };
  };
  return { root, calls, run, configPath };
}

test('maps all supported releases and normalizes SUSHI configuration', () => {
  for (const [version, spec] of [['3.0.2', 'stu3'], ['4.0.1', 'r4'], ['4.3.0', 'r4b'], ['5.0.0', 'r5']]) {
    assert.equal(readConfig(yaml.replace('4.0.1', version)).spec, spec);
  }
  assert.equal(readConfig(yaml.replace('4.0.1', '[4.0.1]')).fhirVersion, '4.0.1');
  assert.deepEqual(readConfig(yaml).dependencies, { 'example.base': '2.0.0', 'example.extended': '3.0.0' });
  for (const bad of ['[]', yaml.replace('id: example.ig', 'id:'), yaml.replace('4.0.1', '6.0.0'), yaml.replace('4.0.1', '[4.0.1, 5.0.0]'), yaml + '\n  bad: {}']) {
    assert.throws(() => readConfig(bad));
  }
});

test('initializes a missing package then runs SUSHI and validation', async (t) => {
  const f = await fixture(t);
  const results = [];
  const summary = await validateIg({ ...f, onResult: (result) => results.push(result) });
  assert.deepEqual(summary, { validated: 2, passed: 1, failed: 1, skipped: 2, warnings: [] });
  assert.deepEqual(f.calls.slice(0, 7).map((call) => call[1]),
    ['--version', '--version', '?', 'spec', 'init', 'restore', '.']);
  assert.ok(f.calls.filter((call) => call[1] === 'validate').every((call) => call[3] === '--fail'));
  assert.ok(f.calls.filter((call) => call[1] === 'validate').every((call) => call[2].startsWith('fsh-generated/resources/')));
  assert.equal(results.filter((result) => !result.passed).length, 1);
  assert.match(await fs.readFile(path.join(f.root, 'package.json'), 'utf8'), /"name": "example\.ig"/);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(f.root, 'fhirpkg.lock.json'), 'utf8')).dependencies,
    {
      'hl7.fhir.r4.core': '4.0.1',
      'example.base': '2.0.0',
      'example.extended': '3.0.0',
    },
  );
});

test('validates only Bundles and retains generated manifests', async (t) => {
  const f = await fixture(t);
  const summary = await validateIg(f);
  assert.equal(summary.validated, 2);
  assert.ok(f.calls.filter((call) => call[1] === 'validate')
    .every((call) => path.basename(call[2]).startsWith('Bundle-')));
  for (const name of ['package.json', 'fhirpkg.lock.json']) assert.ok(await fs.stat(path.join(f.root, name)));
});

for (const stage of ['--version', 'spec']) {
  test(`stops on ${stage} failure without changing package.json`, async (t) => {
    const f = await fixture(t, { hook: async (_, args) => args[0] === stage ? { code: 1, output: 'failure' } : undefined });
    await fs.writeFile(path.join(f.root, 'package.json'), 'original');
    await assert.rejects(validateIg(f), /failed/);
    assert.equal(await fs.readFile(path.join(f.root, 'package.json'), 'utf8'), 'original');
    assert.ok(!f.calls.some((call) => call[1] === 'validate'));
    await assert.rejects(fs.stat(path.join(f.root, 'fhirpkg.lock.json')), { code: 'ENOENT' });
  });
}

test('stops when fhir init fails to create a missing package', async (t) => {
  const f = await fixture(t, {
    hook: async (_, args) => args[0] === 'init' ? { code: 1, output: 'failure' } : undefined,
  });
  await assert.rejects(validateIg(f), /failed/);
  await assert.rejects(fs.stat(path.join(f.root, 'package.json')), { code: 'ENOENT' });
  assert.ok(!f.calls.some((call) => call[1] === 'restore'));
});

test('a SUSHI failure keeps successfully prepared Firely manifests', async (t) => {
  const f = await fixture(t, { hook: async (_, args) => args[0] === '.' ? { code: 1, output: 'failure' } : undefined });
  await assert.rejects(validateIg(f), /failed/);
  assert.match(await fs.readFile(path.join(f.root, 'package.json'), 'utf8'), /"name": "example\.ig"/);
  assert.ok(!f.calls.some((call) => call[1] === 'validate'));
});

test('continues with an explicit warning after restore failure', async (t) => {
  const f = await fixture(t, { hook: async (_, args) => args[0] === 'restore' ? { code: 1, output: 'missing package' } : undefined });
  const summary = await validateIg(f);
  assert.equal(summary.warnings.length, 1);
  assert.equal(summary.validated, 2);
  await validateIg(f);
  assert.equal(f.calls.filter((call) => call[1] === 'restore').length, 2);
});

test('skips restore only when every locked package is in the Firely cache', async (t) => {
  const f = await fixture(t, { packagesAvailable: true });
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({
    name: 'example.ig',
    version: '1.2.3',
    fhirVersions: ['4.0.1'],
    dependencies: {
      'hl7.fhir.r4.core': '4.0.1',
      'example.extended': '3.0.0',
      'example.base': '2.0.0',
    },
  }));
  const lock = JSON.stringify({ dependencies: {
    'hl7.fhir.r4.core': '4.0.1',
    'example.extended': '3.0.0',
    'example.base': '2.0.0',
  }, missing: {} });
  await fs.writeFile(path.join(f.root, 'fhirpkg.lock.json'), lock);
  await validateIg(f);
  assert.equal(f.calls.filter((call) => call[1] === 'init').length, 0);
  assert.equal(f.calls.filter((call) => call[1] === 'restore').length, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'fhirpkg.lock.json'), 'utf8'), lock);
});

test('restores matching manifests when a locked package is absent from the local cache', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({
    name: 'example.ig',
    version: '1.2.3',
    dependencies: {
      'hl7.fhir.r4.core': '4.0.1',
      'example.extended': '3.0.0',
      'example.base': '2.0.0',
    },
  }));
  await fs.writeFile(path.join(f.root, 'fhirpkg.lock.json'), JSON.stringify({ dependencies: {
    'hl7.fhir.r4.core': '4.0.1',
    'example.extended': '3.0.0',
    'example.base': '2.0.0',
  }, missing: {} }));

  await validateIg(f);

  assert.equal(f.calls.filter((call) => call[1] === 'init').length, 0);
  assert.equal(f.calls.filter((call) => call[1] === 'cache').length, 1);
  assert.equal(f.calls.filter((call) => call[1] === 'restore').length, 1);
});

test('updates only dependencies in an existing package and restores without initializing', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({
    name: 'keep-this-name',
    private: true,
    dependencies: {
      'hl7.fhir.r4.core': '4.0.1',
      'example.base': '1.0.0',
      stale: '9.9.9',
    },
  }));

  await validateIg(f);

  const manifest = JSON.parse(await fs.readFile(path.join(f.root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'keep-this-name');
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.dependencies, {
    'hl7.fhir.r4.core': '4.0.1',
    'example.base': '2.0.0',
    'example.extended': '3.0.0',
  });
  assert.equal(f.calls.filter((call) => call[1] === 'init').length, 0);
  assert.equal(f.calls.filter((call) => call[1] === 'restore').length, 1);
});

test('compares only dependency name/version pairs and ignores Firely core packages', () => {
  const { packageMatchesConfig } = require('../src/firely');
  const config = readConfig(yaml);
  const dependencies = {
    'hl7.fhir.r5.core': '5.0.0',
    'example.extended': '3.0.0',
    'example.base': '2.0.0',
  };
  assert.equal(packageMatchesConfig({ dependencies }, config), true);
  assert.equal(packageMatchesConfig({ fhirVersions: ['5.0.0'], dependencies }, config), true);
  assert.equal(packageMatchesConfig({ dependencies: { ...dependencies, extra: '1.0.0' } }, config), false);
  assert.equal(packageMatchesConfig({
    dependencies: { ...dependencies, 'example.base': '2.1.0' },
  }, config), false);
  const { ['example.base']: removed, ...missingDependency } = dependencies;
  void removed;
  assert.equal(packageMatchesConfig({ dependencies: missingDependency }, config), false);
  assert.equal(packageMatchesConfig({
    dependencies: { ...dependencies, 'hl7.fhir.us.core': '1.0.0' },
  }, config), false);
});

test('mutes exit 255 caused by outdated circular dependencies and caches the restore', async (t) => {
  const f = await fixture(t, { hook: async (_, args) => args[0] === 'restore'
    ? { code: 255, output: 'Outdated circular dependencies were found.' }
    : undefined });
  const logs = [];
  const summary = await validateIg({ ...f, log: (text) => logs.push(text) });
  assert.deepEqual(summary.warnings, []);
  assert.ok(!logs.join('').includes('Outdated circular dependencies'));
  assert.ok(!logs.join('').includes('restore exited with status 255'));
  await validateIg(f);
  assert.equal(f.calls.filter((call) => call[1] === 'restore').length, 1);
});

test('a failing progress callback after setup leaves prepared manifests reusable', async (t) => {
  const f = await fixture(t);
  const progressError = new Error('Progress UI disposed');
  await assert.rejects(validateIg({
    ...f,
    progress(message) {
      if (message.startsWith('Building')) throw progressError;
    },
  }), (error) => error === progressError);
  assert.match(await fs.readFile(path.join(f.root, 'package.json'), 'utf8'), /"name": "example\.ig"/);
  assert.ok(await fs.stat(path.join(f.root, 'fhirpkg.lock.json')));
});

test('empty output errors, skipped-only output warns, malformed JSON fails', async (t) => {
  await assert.rejects(validateIg(await fixture(t, { files: {} })), /no JSON resources/);
  const skipped = await validateIg(await fixture(t, { files: { 'profile.json': { resourceType: 'StructureDefinition' } } }));
  assert.equal(skipped.validated, 0);
  assert.equal(skipped.warnings.length, 1);
  assert.match(skipped.warnings[0], /No Bundles/);
  const malformed = await validateIg(await fixture(t, { files: { 'broken.json': '{' } }));
  assert.equal(malformed.failed, 1);
});

test('starts every validator before any finishes and drains them on cancellation', { timeout: 5000 }, async (t) => {
  let active = 0;
  let peak = 0;
  const controller = new AbortController();
  let release;
  const allStarted = new Promise((resolve) => { release = resolve; });
  const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`Bundle-${i}.json`, {
    resourceType: 'Bundle', type: 'collection',
  }]));
  const f = await fixture(t, { files, hook: async (_, args) => {
    if (args[0] !== 'validate') return;
    active++;
    peak = Math.max(peak, active);
    if (active === 8) release();
    await allStarted;
    assert.ok(await fs.stat(path.join(f.root, 'package.json')));
    controller.abort();
    active--;
  } });
  await assert.rejects(validateIg({ ...f, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(active, 0);
  assert.equal(peak, 8);
  assert.equal(f.calls.filter((call) => call[1] === 'validate').length, 8);
  assert.ok(await fs.stat(path.join(f.root, 'package.json')));
});

test('reuses restored packages until SUSHI dependencies change', async (t) => {
  const f = await fixture(t);
  await validateIg(f);
  await validateIg(f);
  assert.equal(f.calls.filter((call) => call[1] === 'init').length, 1);
  assert.equal(f.calls.filter((call) => call[1] === 'restore').length, 1);
  assert.equal(f.calls.filter((call) => call[1] === 'spec').length, 2);
  assert.equal(f.calls.filter((call) => call[1] === '.').length, 2);

  await fs.writeFile(f.configPath, yaml.replace('example.base: 2.0.0', 'example.base: 2.1.0'));
  await validateIg(f);
  assert.equal(f.calls.filter((call) => call[1] === 'init').length, 1);
  assert.equal(f.calls.filter((call) => call[1] === 'restore').length, 2);
});

test('can skip SUSHI and removes stale publisher output before Firely runs', async (t) => {
  const f = await fixture(t, { hook: async (exe, args) => {
    if (args[0] === 'spec') await assert.rejects(fs.stat(path.join(f.root, 'output')), { code: 'ENOENT' });
  } });
  await fs.mkdir(path.join(f.root, 'output'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'output', 'stale.json'), '{}');
  const generated = path.join(f.root, 'fsh-generated', 'resources');
  await fs.mkdir(generated, { recursive: true });
  await fs.writeFile(path.join(generated, 'Bundle-existing.json'), JSON.stringify({
    resourceType: 'Bundle', type: 'collection',
  }));
  const summary = await validateIg({ ...f, runSushi: false, deleteOutput: true });
  assert.equal(summary.validated, 1);
  assert.ok(!f.calls.some(([exe]) => exe === 'sushi'));
  assert.ok(!f.calls.some((call) => call[1] === '.'));
});

test('leaves publisher output untouched without deletion consent', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'output'), { recursive: true });
  const marker = path.join(f.root, 'output', 'keep.txt');
  await fs.writeFile(marker, 'keep');
  await validateIg(f);
  assert.equal(await fs.readFile(marker, 'utf8'), 'keep');
});

test('explains how to generate resources when SUSHI is skipped', async (t) => {
  const f = await fixture(t);
  await assert.rejects(validateIg({ ...f, runSushi: false }), (error) => {
    assert.match(error.message, /No generated FHIR resources were found/);
    assert.match(error.message, /Run SUSHI/);
    assert.ok(!error.message.includes('ENOENT'));
    return true;
  });
});

test('a validator that cannot start is reported without abandoning the other results', async (t) => {
  const f = await fixture(t, { hook: async (_, args) => {
    if (args[0] === 'validate' && args[1].endsWith('Bundle-bad.json')) {
      throw new Error('Could not launch validator');
    }
  } });
  const results = [];
  const summary = await validateIg({ ...f, onResult: (result) => results.push(result) });
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.match(results.find((result) => !result.passed).output, /Could not launch/);
  assert.ok(!(await fs.readdir(f.root)).some((name) => name.endsWith('.md') || name === 'firely-validation-reports'));
});

test('does not replace a symlinked manifest', async (t) => {
  if (process.platform === 'win32') return t.skip('Symlink creation requires privileges on Windows');
  const f = await fixture(t);
  const target = path.join(f.root, 'original.json');
  await fs.writeFile(target, 'original');
  await fs.symlink(target, path.join(f.root, 'package.json'));
  await assert.rejects(validateIg(f), /not a regular file/);
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
});

test('handles findings, process failures, and warning-only results', () => {
  for (const output of ['Result: INVALID', '\x1b[31mError: invalid value\x1b[0m', 'Fatal: missing profile']) {
    assert.equal(validationPassed({ code: 0, output }), false);
  }
  assert.equal(validationPassed({ code: 1, output: '' }), false);
  assert.equal(validationPassed({ code: 0, output: 'Warning: missing narrative\nResult: VALID' }), true);
});

test('runner passes paths literally, captures stderr, and reports missing commands', async () => {
  const argument = 'file with spaces $(echo nope); & literal.json';
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write(" stderr"); process.exitCode = 2;', argument]);
  assert.equal(result.code, 2);
  assert.ok(result.output.includes(argument));
  assert.ok(result.output.includes('stderr'));
  await assert.rejects(runProcess('nonexistent-firely-test-command', []), /Cannot run/);
});

test('runner cancels a running subprocess and rejects an already cancelled run', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const promise = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(promise, { name: 'AbortError' });
  assert.ok(Date.now() - started < 1000, 'cancellation should kill the process immediately');
  assert.throws(() => runProcess(process.execPath, [], { signal: controller.signal }), { name: 'AbortError' });
});
