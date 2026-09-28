const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MANIFEST_NAMES = ['package.json', 'fhirpkg.lock.json'];

async function statIfExists(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return undefined;
  }
}

async function backupManifest(root, backupDirectory, name) {
  const file = path.join(root, name);
  const stat = await statIfExists(file);
  if (stat && !stat.isFile()) {
    throw new Error(`Cannot temporarily replace ${file}: it is not a regular file.`);
  }
  if (stat) {
    await fs.copyFile(file, path.join(backupDirectory, name));
  }
  return { name, stat };
}

async function restoreManifest(root, backupDirectory, { name, stat }) {
  const file = path.join(root, name);
  await fs.rm(file, { force: true });
  if (stat) {
    await fs.copyFile(path.join(backupDirectory, name), file);
    await fs.chmod(file, stat.mode);
  }
}

async function preserveManifests(root) {
  // Keep backups outside the IG so Firely cannot discover them as resources.
  const backupDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'fhir-ig-manifests-'));
  const saved = [];
  try {
    for (const name of MANIFEST_NAMES) {
      saved.push(await backupManifest(root, backupDirectory, name));
    }
  } catch (error) {
    await fs.rm(backupDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    async remove() {
      for (const { name } of saved) {
        await fs.rm(path.join(root, name), { force: true });
      }
    },
    async restore() {
      const errors = [];
      // Attempt both files even if one cannot be restored, retaining backups on failure.
      for (const manifest of saved) {
        try {
          await restoreManifest(root, backupDirectory, manifest);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors,
          `Could not restore project manifests: ${errors.map((error) => error.message).join('; ')}. ` +
          `Originals are saved in ${backupDirectory}.`);
      }
      await fs.rm(backupDirectory, { recursive: true, force: true });
    },
    async commit() {
      await fs.rm(backupDirectory, { recursive: true, force: true });
    },
  };
}

async function withTemporaryManifests(root, action) {
  const manifests = await preserveManifests(root);
  const errors = [];
  let result;
  try {
    await manifests.remove();
    result = await action();
  } catch (error) {
    errors.push(error);
  }

  // No UI callbacks run between the action and restoration.
  try {
    await manifests.restore();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors,
      `Validation failed: ${errors[0].message}\nCleanup also failed: ${errors[1].message}`);
  }
  return result;
}

module.exports = { preserveManifests, withTemporaryManifests };
