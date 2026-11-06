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
  const notifications = [];
  const statuses = [];
  const commands = new Map();
  function showMessage(severity, message, ...actions) {
    const [action] = actions;
    notifications.push({ severity, message, actions });
    prompts++;
    if (holdPrompt) return new Promise((resolve) => { choose = resolve; });
    return Promise.resolve(consent ? action : 'Not Now');
  }
  const vscode = {
    StatusBarAlignment: { Right: 2 },
    commands: {
      registerCommand(command, callback) {
        commands.set(command, callback);
        return { dispose() { commands.delete(command); } };
      },
    },
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
      showInformationMessage: (...args) => showMessage('info', ...args),
      showWarningMessage: (...args) => showMessage('warning', ...args),
      createStatusBarItem(alignment) {
        const status = { alignment, visible: false, disposed: false,
          show() { this.visible = true; },
          dispose() { this.visible = false; this.disposed = true; } };
        statuses.push(status);
        return status;
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
    notifications, statuses, commands,
    choose: (value) => choose(value), hasListener: () => !!listener };
}

test('keeps managed preview dependencies in their own helper subdirectory', () => {
  const setup = fixture();
  const unix = setup.previewPaths('/user', { XDG_DATA_HOME: '/data' }, 'linux');
  assert.equal(unix.root, path.join('/data', 'medcom-fhir-ig-helper', 'preview'));
  assert.equal(unix.jekyll, path.join(unix.root, 'bin', 'jekyll'));
  const windows = setup.previewPaths('/user', { LOCALAPPDATA: '/local' }, 'win32');
  assert.equal(windows.root, path.join('/local', 'medcom-fhir-ig-helper', 'preview'));
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

test('genonce rebuild offers notification buttons and a status bar action with exact filenames', async () => {
  for (const consent of [true, false]) {
    const setup = fixture({ consent });
    const files = ['input/fsh/profile.fsh', 'sushi-config.yaml', 'input/resources/example.json'];
    assert.equal(await setup.confirmPublisherRebuild(files), consent);
    const { severity, message, actions } = setup.notifications[0];
    assert.equal(severity, 'warning');
    for (const file of files) {
      assert.ok(message.includes(file));
      assert.ok(setup.statuses[0].tooltip.includes(file));
    }
    assert.match(message, /require a full genonce rebuild/);
    assert.deepEqual(actions, ['Run Full genonce Rebuild', 'Not Now']);
    assert.equal(setup.statuses[0].disposed, true);
    assert.equal(setup.commands.size, 0);
  }
});

test('hiding a rebuild notification leaves a clickable status bar action until an explicit choice', async () => {
  const setup = fixture({ holdPrompt: true });
  let settled = false;
  const confirmation = setup.confirmPublisherRebuild(['sushi-config.yaml']);
  void confirmation.then(() => { settled = true; });
  setup.choose(undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  const status = setup.statuses[0];
  assert.equal(status.alignment, 2);
  assert.equal(status.visible, true);
  assert.match(status.text, /Run Full genonce Rebuild/);
  setup.commands.get(status.command)();
  assert.equal(await confirmation, true);
  assert.equal(status.disposed, true);
  assert.equal(setup.commands.size, 0);
});

test('an already cancelled rebuild never shows a notification', () => {
  const setup = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => setup.confirmPublisherRebuild(['sushi-config.yaml'], controller.signal), { name: 'AbortError' });
  assert.equal(setup.notifications.length, 0);
  assert.equal(setup.statuses.length, 0);
});

test('stopping clears the rebuild action and ignores late notification and status bar consent', async () => {
  const setup = fixture({ holdPrompt: true });
  const controller = new AbortController();
  const choice = setup.confirmPublisherRebuild(['sushi-config.yaml'], controller.signal);
  const status = setup.statuses[0];
  const click = setup.commands.get(status.command);
  controller.abort();
  assert.equal(await choice, false);
  assert.equal(status.disposed, true);
  assert.equal(setup.commands.size, 0);
  setup.choose('Run Full genonce Rebuild');
  click();
  assert.equal(await choice, false);
});

test('simultaneous guide rebuild prompts have independent actions and cancellation', async () => {
  const setup = fixture({ holdPrompt: true });
  const firstController = new AbortController();
  const first = setup.confirmPublisherRebuild(['input/fsh/profile.fsh'], firstController.signal);
  const second = setup.confirmPublisherRebuild(['sushi-config.yml']);
  const [firstStatus, secondStatus] = setup.statuses;
  assert.notEqual(firstStatus.command, secondStatus.command);
  firstController.abort();
  assert.equal(await first, false);
  assert.equal(secondStatus.visible, true);
  setup.commands.get(secondStatus.command)();
  assert.equal(await second, true);
  assert.equal(setup.commands.size, 0);
});
