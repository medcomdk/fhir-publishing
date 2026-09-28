const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { withTemporaryManifests } = require('../src/manifests');

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'firely-cleanup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), 'original package');
  await fs.writeFile(path.join(root, 'fhirpkg.lock.json'), 'original lock');
  return root;
}

for (const actionFails of [false, true]) {
  test(`restoration failure retains backups and ${actionFails ? 'the original error' : 'its recovery location'}`, async (t) => {
    const root = await project(t);
    const originalError = new Error('SUSHI build failed');
    let reportedError;
    await assert.rejects(withTemporaryManifests(root, async () => {
      // A nonempty directory cannot be replaced by the normal file cleanup.
      await fs.mkdir(path.join(root, 'package.json'));
      await fs.writeFile(path.join(root, 'package.json', 'blocker'), 'blocker');
      await fs.writeFile(path.join(root, 'fhirpkg.lock.json'), 'temporary lock');
      if (actionFails) throw originalError;
    }), (error) => {
      reportedError = error;
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /Could not restore project manifests/);
      if (actionFails) {
        assert.equal(error.errors[0], originalError);
        assert.match(error.message, /SUSHI build failed/);
        assert.match(error.message, /Cleanup also failed/);
      }
      return true;
    });
    const backupDirectory = reportedError.message.match(/Originals are saved in (.+)\.$/)[1];
    t.after(() => fs.rm(backupDirectory, { recursive: true, force: true }));
    assert.equal(await fs.readFile(path.join(backupDirectory, 'package.json'), 'utf8'), 'original package');
    assert.equal(await fs.readFile(path.join(root, 'fhirpkg.lock.json'), 'utf8'), 'original lock');
  });
}
