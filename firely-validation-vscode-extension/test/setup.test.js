const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadSetup({ exitCode = 0, endOnStart = true, platform = process.platform } = {}) {
  const file = path.resolve(__dirname, '../src/setup.js');
  const localRequire = createRequire(file);
  let listener;
  let started;

  class ProcessExecution {
    constructor(command, args, options) {
      Object.assign(this, { command, args, options });
    }
  }

  class Task {
    constructor(definition, scope, name, source, execution) {
      Object.assign(this, { definition, scope, name, source, execution });
    }
  }

  const vscode = {
    ProcessExecution,
    Task,
    TaskScope: { Workspace: 1 },
    TaskRevealKind: { Always: 1 },
    TaskPanelKind: { Dedicated: 1 },
    tasks: {
      onDidEndTaskProcess(callback) {
        listener = callback;
        return { dispose() { listener = undefined; } };
      },
      async executeTask(task) {
        started = {
          task,
          terminate() {
            listener?.({ execution: started, exitCode: undefined });
          },
        };
        if (endOnStart) queueMicrotask(() => listener?.({ execution: started, exitCode }));
        return started;
      },
    },
  };

  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module,
    process: { ...process, platform, env: process.env },
    require(name) {
      return name === 'vscode' ? vscode : localRequire(name);
    },
  }, { filename: file });

  return { ...module.exports, getStarted: () => started };
}

test('runs the setup script as a visible workspace task and waits for success', async () => {
  const setup = loadSetup();
  await setup.runToolSetup('/extension/install-tools.sh', '/workspace/ig');
  const task = setup.getStarted().task;
  assert.equal(task.execution.command, 'bash');
  assert.deepEqual(Array.from(task.execution.args), ['/extension/install-tools.sh', process.execPath]);
  assert.equal(task.execution.options.cwd, '/workspace/ig');
  assert.equal(task.presentationOptions.reveal, 1);
});

test('runs the native PowerShell installer in a Windows extension host', async () => {
  const setup = loadSetup({ platform: 'win32' });
  await setup.runToolSetup('C:\\extension\\install-tools.sh', 'C:\\workspace\\ig');
  const task = setup.getStarted().task;
  assert.equal(task.execution.command, 'powershell.exe');
  assert.deepEqual(Array.from(task.execution.args), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'C:\\extension\\install-tools.ps1',
  ]);
  assert.equal(task.execution.options.cwd, 'C:\\workspace\\ig');
});

test('uses local application data for tools installed on Windows', () => {
  const setup = loadSetup();
  const localData = 'C:\\Users\\OLW\\AppData\\Local';
  const paths = setup.toolPaths('C:\\Users\\OLW', { LOCALAPPDATA: localData }, 'win32');
  const installRoot = path.join(localData, 'medcom-firely-validation');
  assert.equal(paths.userBin, path.join(installRoot, 'bin'));
  assert.equal(paths.nodeBin, path.join(installRoot, 'node'));
  assert.equal(paths.dotnetBin, path.join(installRoot, 'dotnet'));
});

test('terminates setup when validation is cancelled', async () => {
  const setup = loadSetup({ endOnStart: false });
  const controller = new AbortController();
  const running = setup.runToolSetup('/extension/install-tools.sh', '/workspace/ig', controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
});
