const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture(t, { platform = 'linux', exitCode = 0, output = true, missingScript = false, hold = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'publisher preview build '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = platform === 'win32' ? '_genonce.bat' : '_genonce.sh';
  if (!missingScript) await fs.writeFile(path.join(root, script), 'test build script');
  let listener;
  let execution;
  let started;
  const starting = new Promise((resolve) => { started = resolve; });
  const vscode = {
    Task: class {
      constructor(definition, scope, name, source, execution) { Object.assign(this, { definition, scope, name, source, execution }); }
    },
    ProcessExecution: class {
      constructor(command, args, options) { Object.assign(this, { command, args, options }); }
    },
    TaskScope: { Workspace: 1 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 1 },
    tasks: {
      onDidEndTaskProcess(callback) { listener = callback; return { dispose() { listener = undefined; } }; },
      async executeTask(task) {
        execution = { task, terminate() { listener?.({ execution, exitCode: undefined }); } };
        if (!hold) {
          if (output) {
            await fs.mkdir(path.join(root, 'temp', 'pages', '_includes'), { recursive: true });
            await fs.writeFile(path.join(root, 'temp', 'pages', '_config.yml'), 'title: Full build\n');
          }
          queueMicrotask(() => listener?.({ execution, exitCode }));
        }
        started();
        return execution;
      },
    },
  };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const localRequire = createRequire(file);
    const module = { exports: {} };
    cache.set(file, module);
    vm.runInNewContext(syncFs.readFileSync(file, 'utf8'), {
      module, process: { ...process, platform },
      require(name) {
        if (name === 'vscode') return vscode;
        if (name === './preview-setup') return load(localRequire.resolve(name));
        return localRequire(name);
      },
    }, { filename: file });
    return module.exports;
  }
  return {
    root, starting,
    ...load(path.resolve(__dirname, '../src/preview-build.js')),
    getExecution: () => execution, hasListener: () => !!listener,
  };
}

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`runs the guide's native Publisher script on ${platform}, supplies managed Jekyll, and verifies output`, async (t) => {
    const build = await fixture(t, { platform });
    const jekyll = path.join('/private tools', 'bin', platform === 'win32' ? 'jekyll.cmd' : 'jekyll');
    await build.runPublisherBuild(build.root, jekyll);
    const task = build.getExecution().task;
    assert.equal(task.definition.type, 'fhirIg.publisherBuild');
    assert.equal(task.execution.command, platform === 'win32' ? 'cmd.exe' : 'bash');
    assert.deepEqual(Array.from(task.execution.args), platform === 'win32' ? ['/d', '/c', '_genonce.bat'] : ['./_genonce.sh']);
    assert.equal(task.execution.options.cwd, build.root);
    assert.ok(task.execution.options.env.PATH.startsWith(path.dirname(jekyll) + (platform === 'win32' ? ';' : ':')));
    assert.equal(task.presentationOptions.reveal, 1);
    assert.equal(build.hasListener(), false);
  });
}

test('a successful exit without the required Publisher files does not start preview', async (t) => {
  const build = await fixture(t, { output: false });
  await assert.rejects(build.runPublisherBuild(build.root, 'jekyll'), /files needed for preview are still missing/);
  assert.equal(build.getExecution().task.execution.options.env, undefined);
});

test('a failed Publisher build is reported even if it leaves partial preview files', async (t) => {
  const build = await fixture(t, { exitCode: 1 });
  await assert.rejects(build.runPublisherBuild(build.root, 'jekyll'), /Full Publisher build failed \(exit 1\)/);
  assert.equal(build.hasListener(), false);
});

test('explains a missing Publisher build script without starting any task', async (t) => {
  const build = await fixture(t, { missingScript: true });
  await assert.rejects(build.runPublisherBuild(build.root, 'jekyll'), /_genonce.sh was not found/);
  assert.equal(build.getExecution(), undefined);
});

test('Stop cancels the running Publisher task and waits for its termination', async (t) => {
  const build = await fixture(t, { hold: true });
  const controller = new AbortController();
  const completion = build.runPublisherBuild(build.root, 'jekyll', controller.signal);
  await build.starting;
  controller.abort();
  await assert.rejects(completion, { name: 'AbortError' });
  assert.equal(build.hasListener(), false);
});
