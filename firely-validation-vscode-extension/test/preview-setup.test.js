const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture({ platform = 'linux', exitCode = 0, holdTask = false, holdPrompt = false, consent = true, installed = false } = {}) {
  const file = path.resolve(__dirname, '../src/preview-setup.js');
  const localRequire = createRequire(file);
  let listener;
  let execution;
  let choose;
  let prompts = 0;
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
        if (!holdTask) queueMicrotask(() => listener?.({ execution, exitCode }));
        return execution;
      },
    },
    window: {
      showInformationMessage: (message, action) => {
        prompts++;
        if (holdPrompt) return new Promise((resolve) => { choose = resolve; });
        return Promise.resolve(consent ? action : 'Not Now');
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, process: { ...process, platform },
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:fs') return { existsSync: () => installed };
      return localRequire(name);
    },
  }, { filename: file });
  return { ...module.exports, getExecution: () => execution, getPrompts: () => prompts,
    choose: (value) => choose(value), hasListener: () => !!listener };
}

test('keeps managed preview dependencies outside the validation tool directory', () => {
  const setup = fixture();
  const unix = setup.previewPaths('/user', { XDG_DATA_HOME: '/data' }, 'linux');
  assert.equal(unix.root, path.join('/data', 'medcom-ig-preview'));
  assert.equal(unix.jekyll, path.join(unix.root, 'bin', 'jekyll'));
  const windows = setup.previewPaths('/user', { LOCALAPPDATA: '/local' }, 'win32');
  assert.equal(windows.root, path.join('/local', 'medcom-ig-preview'));
  assert.equal(windows.jekyll, path.join(windows.root, 'bin', 'jekyll.cmd'));
});

test('reuses a managed Jekyll on subsequent runs but preserves explicit executable settings', () => {
  assert.equal(fixture().resolveJekyllPath(), 'jekyll');
  const setup = fixture({ installed: true });
  assert.equal(setup.resolveJekyllPath(), setup.previewPaths().jekyll);
  assert.equal(setup.resolveJekyllPath('/custom/jekyll'), '/custom/jekyll');
});

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`runs only the preview installer on ${platform} and returns its executable`, async () => {
    const setup = fixture({ platform });
    const executable = await setup.runPreviewSetup('/extension/install-preview-tools.sh', '/guide');
    const task = setup.getExecution().task;
    assert.equal(task.definition.type, 'fhirIg.previewSetup');
    assert.equal(task.execution.options.cwd, '/guide');
    assert.equal(task.presentationOptions.reveal, 1);
    assert.equal(executable, setup.previewPaths().jekyll);
    if (platform === 'win32') {
      assert.equal(task.execution.command, 'powershell.exe');
      assert.ok(task.execution.args.includes('/extension/install-preview-tools.ps1'));
      assert.ok(task.execution.args.includes('-InstallRoot'));
    } else {
      assert.equal(task.execution.command, 'bash');
      assert.equal(task.execution.args[0], '/extension/install-preview-tools.sh');
    }
    assert.equal(setup.hasListener(), false);
  });
}

test('reports failed installation and disposes the task subscription', async () => {
  const setup = fixture({ exitCode: 8 });
  await assert.rejects(setup.runPreviewSetup('/extension/install-preview-tools.sh', '/guide'), /installation failed \(exit 8\)/);
  assert.equal(setup.hasListener(), false);
});

test('stopping preview terminates its installer task', async () => {
  const setup = fixture({ holdTask: true });
  const controller = new AbortController();
  const completion = setup.runPreviewSetup('/extension/install-preview-tools.sh', '/guide', controller.signal);
  controller.abort();
  await assert.rejects(completion, { name: 'AbortError' });
  assert.equal(setup.hasListener(), false);
});

for (const consent of [true, false]) {
  test(`requires affirmative consent for installation (consent: ${consent})`, async () => {
    const setup = fixture({ consent });
    assert.equal(await setup.confirmPreviewSetup(), consent);
  });
}

test('stopping while the consent notification is open releases the session and ignores late consent', async () => {
  const setup = fixture({ holdPrompt: true });
  const controller = new AbortController();
  const choice = setup.confirmPreviewSetup(controller.signal);
  controller.abort();
  assert.equal(await choice, false);
  setup.choose('Install Preview Dependencies');
  assert.equal(await choice, false);
});

test('an already cancelled preview never displays an installation prompt or starts a task', async () => {
  const setup = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => setup.confirmPreviewSetup(controller.signal), { name: 'AbortError' });
  await assert.rejects(setup.runPreviewSetup('/installer.sh', '/guide', controller.signal), { name: 'AbortError' });
  assert.equal(setup.getPrompts(), 0);
  assert.equal(setup.getExecution(), undefined);
});

test('the full Publisher build prompt also requires explicit consent', async () => {
  assert.equal(await fixture({ consent: true }).confirmPublisherBuild(), true);
  assert.equal(await fixture({ consent: false }).confirmPublisherBuild(), false);
});

test('stopping dismisses a pending Publisher build choice and ignores late consent', async () => {
  const setup = fixture({ holdPrompt: true });
  const controller = new AbortController();
  const choice = setup.confirmPublisherBuild(controller.signal);
  controller.abort();
  assert.equal(await choice, false);
  setup.choose('Run Full Publisher Build');
  assert.equal(await choice, false);
});
