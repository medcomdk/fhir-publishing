// Optional smoke test with real SUSHI, Firely Terminal, and package access.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateIg } = require('../src/workflow');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'firely-integration-'));
  try {
    await fs.cp(path.join(__dirname, 'fixtures/ig'), root, { recursive: true });
    const original = '{"name":"existing-project","version":"1.0.0"}\n';
    await fs.writeFile(path.join(root, 'package.json'), original);
    const summary = await validateIg({
      configPath: path.join(root, 'sushi-config.yaml'),
      log: (text) => process.stdout.write(text),
    });
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.skipped, 3);
    assert.equal(summary.warnings.length, 0);
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'example.firely-validator');
    assert.ok(await fs.stat(path.join(root, 'fhirpkg.lock.json')));
    await assert.rejects(fs.stat(path.join(root, '.firely-validation-state.json')), { code: 'ENOENT' });
    console.log('Real SUSHI/Firely integration test passed.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
