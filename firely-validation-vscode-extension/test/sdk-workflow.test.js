const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateIgWithSdk: validateIg } = require('../src/sdk-workflow');
const { readConfig } = require('../src/config');

async function fixture(t, { exitCode = 1, report = true, hook = () => {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk test with spaces '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'sushi-config.yaml');
  await fs.writeFile(configPath, 'id: example.ig\nversion: 1.0.0\nfhirVersion: 4.0.1\n');
  await fs.writeFile(path.join(root, '_genonce.sh'), '#!/usr/bin/env bash\n');
  await fs.mkdir(path.join(root, 'output'));
  await fs.writeFile(path.join(root, 'output/package.tgz'), 'test package');
  await fs.writeFile(path.join(root, 'package.json'), 'original manifest');
  const resources = path.join(root, 'output');
  await fs.mkdir(resources, { recursive: true });
  const file = path.join(resources, 'Bundle-example.json');
  await fs.writeFile(file, JSON.stringify({ resourceType: 'Bundle', type: 'collection' }, null, 2));
  const calls = [];
  let reportPath;
  const run = async (executable, args, options) => {
    calls.push([executable, ...args]);
    assert.equal(options.cwd, root);
    const override = await hook(executable, args, options);
    if (override) return override;
    if (executable === 'bash') {
      assert.equal(options.processGroup, true);
      await assert.rejects(fs.stat(path.join(root, 'output/package.tgz')), { code: 'ENOENT' });
      await fs.writeFile(path.join(root, 'output/package.tgz'), 'fresh package');
    }
    if (args[0] === 'run') {
      assert.equal(options.processGroup, true);
      reportPath = args[args.indexOf('--report') + 1];
      if (report) await fs.writeFile(reportPath, JSON.stringify({
        validated: 1, passed: exitCode === 0 ? 1 : 0, failed: exitCode === 0 ? 0 : 1,
        skipped: 0, warnings: [], results: [{
          file, status: exitCode === 0 ? 'passed' : 'failed',
          output: exitCode === 0 ? '' : 'Error: Invalid Bundle type\nAt: Bundle.type',
        }],
      }));
      return { code: exitCode, output: 'SDK output' };
    }
    return { code: 0, output: 'OK' };
  };
  return { root, configPath, calls, run, getReport: () => reportPath };
}

test('rebuilds the package before SDK validation and keeps source diagnostics', async (t) => {
  const f = await fixture(t);
  const results = [];
  const summary = await validateIg({ ...f, onResult: (result) => results.push(result) });
  assert.equal(summary.failed, 1);
  assert.deepEqual(f.calls.map(([exe, command]) => [exe, command]), [
    ['dotnet', '--version'], ['bash', './_genonce.sh'], ['dotnet', 'run'],
  ]);
  const args = f.calls.at(-1);
  assert.equal(args[args.indexOf('--') + 1], path.join(f.root, 'output/package.tgz'));
  assert.equal(args[args.indexOf('--resource-type') + 1], 'Bundle');
  assert.equal(args[args.indexOf('--resources') + 1], path.join(f.root, 'output'));
  assert.equal(results[0].passed, false);
  assert.equal(results[0].findings[0].range.start.line, 2);
  assert.equal(await fs.readFile(path.join(f.root, 'package.json'), 'utf8'), 'original manifest');
  assert.equal(await fs.readFile(path.join(f.root, 'output/package.tgz'), 'utf8'), 'fresh package');
  await assert.rejects(fs.stat(f.getReport()), { code: 'ENOENT' });
});

test('supports configured SDK and terminology paths', async (t) => {
  const f = await fixture(t, { exitCode: 0 });
  const summary = await validateIg({ ...f, dotnetPath: '/tools/dotnet', terminologyServer: 'https://example.org/r4' });
  assert.equal(summary.passed, 1);
  assert.ok(f.calls.every(([exe]) => ['/tools/dotnet', 'bash'].includes(exe)));
  assert.ok(f.calls.at(-1).includes('https://example.org/r4'));
});

test('requires the workspace script only when rebuilding', async (t) => {
  const f = await fixture(t, { exitCode: 0 });
  await fs.unlink(path.join(f.root, '_genonce.sh'));
  await assert.rejects(validateIg(f), /Cannot read.*_genonce/);
  assert.equal(await fs.readFile(path.join(f.root, 'output/package.tgz'), 'utf8'), 'test package');
  f.calls.length = 0;
  assert.equal((await validateIg({ ...f, runGenonce: false })).passed, 1);
  assert.ok(f.calls.every(([exe]) => exe === 'dotnet'));
  assert.equal(await fs.readFile(path.join(f.root, 'output/package.tgz'), 'utf8'), 'test package');
});

test('requires an existing package when the rebuild is skipped', async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, 'output/package.tgz'));
  await assert.rejects(validateIg({ ...f, runGenonce: false }), (error) => {
    assert.ok(error.message.includes(path.join(f.root, 'output/package.tgz')));
    assert.match(error.message, /"Run _genonce.sh" was not selected/);
    assert.match(error.message, /Run "Validate with SDK" again and select "Run _genonce.sh"/);
    return true;
  });
  assert.equal(f.calls.length, 0);
});

test('rejects unsupported releases before running tools', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.configPath, 'id: example.ig\nversion: 1.0.0\nfhirVersion: 5.0.0\n');
  await assert.rejects(validateIg(f), /R4/);
  assert.equal(f.calls.length, 0);
});

test('uses the workspace root for the script and package when the config is nested', async (t) => {
  const f = await fixture(t, { exitCode: 0 });
  const nested = path.join(f.root, 'nested');
  await fs.mkdir(nested);
  const configPath = path.join(nested, 'sushi-config.yaml');
  await fs.rename(f.configPath, configPath);
  assert.equal((await validateIg({ ...f, configPath, workspaceRoot: f.root })).passed, 1);
  assert.deepEqual(f.calls.find(([exe]) => exe === 'bash'), ['bash', './_genonce.sh']);
  assert.ok(f.calls.at(-1).includes(path.join(f.root, 'output/package.tgz')));
});

for (const code of [0, 1]) {
  test(`a _genonce.sh run without a fresh package stops SDK validation (exit ${code})`, async (t) => {
    const f = await fixture(t, { hook: (executable) => executable === 'bash' ? { code, output: 'No package' } : undefined });
    await assert.rejects(validateIg(f), /failed|did not create/);
    assert.ok(!f.calls.some((call) => call[1] === 'run'));
    await assert.rejects(fs.stat(path.join(f.root, 'output/package.tgz')), { code: 'ENOENT' });
  });
}

for (const exitCode of [0, 1, 2]) {
  test(`missing report cannot pass validation (exit ${exitCode})`, async (t) => {
    const f = await fixture(t, { exitCode, report: false });
    await assert.rejects(validateIg(f), /could not complete|did not produce/);
    await assert.rejects(fs.stat(path.dirname(f.getReport())), { code: 'ENOENT' });
  });
}

test('cancelling the SDK process cleans up its report directory', async (t) => {
  const controller = new AbortController();
  let report;
  const f = await fixture(t, { hook: (_, args) => {
    if (args[0] !== 'run') return;
    report = args[args.indexOf('--report') + 1];
    controller.abort();
    throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
  } });
  await assert.rejects(validateIg({ ...f, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(fs.stat(path.dirname(report)), { code: 'ENOENT' });
});

test('normalizes SUSHI dependencies and rejects multiple FHIR versions', () => {
  assert.deepEqual(readConfig('id: example\nversion: 1.0.0\nfhirVersion: [4.0.1]\ndependencies:\n  example.base:\n    version: 2.0.0').dependencies, { 'example.base': '2.0.0' });
  assert.throws(() => readConfig('id: example\nversion: 1.0.0\nfhirVersion: [4.0.1, 5.0.0]'));
});



test('published Bundle discovery includes JSON and XML but excludes HTML and metadata', async (t) => {
  const { findPublishedBundles } = require('../src/sdk-resources');
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'output/Bundle-example.xml'), '<Bundle xmlns="http://hl7.org/fhir"/>');
  await fs.writeFile(path.join(f.root, 'output/Bundle-example.json.html'), 'html');
  await fs.writeFile(path.join(f.root, 'output/qa.json'), '{}');
  assert.deepEqual((await findPublishedBundles(f.root)).map(file => path.basename(file)), ['Bundle-example.json', 'Bundle-example.xml']);
  await fs.unlink(path.join(f.root, 'output/Bundle-example.json'));
  await fs.unlink(path.join(f.root, 'output/Bundle-example.xml'));
  await assert.rejects(validateIg({ ...f, runGenonce: false }), /No published Bundle JSON or XML/);
  assert.ok(!f.calls.some(call => call[1] === 'run'));
});
