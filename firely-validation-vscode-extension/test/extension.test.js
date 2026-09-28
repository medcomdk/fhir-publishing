const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const configUri = { scheme: 'file', fsPath: '/test/ig/sushi-config.yaml' };
const passingSummary = { passed: 1, failed: 0, skipped: 0, warnings: [] };

function loadExtension(validateIg, {
  holdNotifications = false, candidates = [configUri], runSushi = true, deleteOutput = false,
} = {}) {
  const commands = new Map();
  const notifications = [];
  const notificationShown = deferred();
  const pickerShown = deferred();
  const log = [];
  const outputShows = [];
  const setupCalls = [];
  const diagnosticEntries = [];
  const output = {
    append: (text) => log.push(text),
    appendLine: (text) => log.push(text),
    clear() {},
    show: (preserveFocus) => outputShows.push(preserveFocus),
  };
  const showMessage = (severity) => async (message) => {
    const dismissed = deferred();
    notifications.push({ severity, message, dismiss: dismissed.resolve });
    notificationShown.resolve();
    if (holdNotifications && !message.includes('already running')) {
      return dismissed.promise;
    }
    return undefined;
  };
  const vscode = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{}],
      saveAll: async () => true,
      findFiles: async () => candidates,
      asRelativePath: (uri) => uri.fsPath,
      getConfiguration: () => ({ get: (_, fallback) => fallback }),
    },
    window: {
      createOutputChannel: () => output,
      withProgress: (_, task) => task({ report() {} }, {
        onCancellationRequested: () => ({ dispose() {} }),
      }),
      showInformationMessage: showMessage('information'),
      showWarningMessage: showMessage('warning'),
      showErrorMessage: showMessage('error'),
      showQuickPick: async (items, options, token) => {
        if (options.canPickMany) return items.filter((item) =>
          (item.label === 'Run SUSHI' && runSushi) ||
          (item.label === 'Delete output folder' && deleteOutput));
        pickerShown.resolve();
        return new Promise((resolve) => token.onCancellationRequested(() => resolve(undefined)));
      },
    },
    languages: { createDiagnosticCollection: () => ({
      forEach() {},
      set(uri, entries) { diagnosticEntries.push({ uri, entries }); },
    }) },
    Uri: { file: (fsPath) => ({ fsPath }) },
    Range: class { constructor(...positions) { this.positions = positions; } },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    DiagnosticSeverity: { Error: 0 },
    commands: {
      registerCommand: (name, handler) => { commands.set(name, handler); return {}; },
    },
    ProgressLocation: { Notification: 15 },
    CancellationTokenSource: class {
      constructor() {
        this.listeners = [];
        this.token = { onCancellationRequested: (listener) => this.listeners.push(listener) };
      }
      cancel() { this.listeners.forEach((listener) => listener()); }
      dispose() { this.listeners = []; }
    },
  };

  // Load the real extension, project selection, and UI modules with only VS Code
  // and the external workflow stubbed. Each test gets independent module state.
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const localRequire = createRequire(file);
    const sandbox = {
      module,
      AbortController,
      process,
      require(name) {
        if (name === 'vscode') return vscode;
        if (name === './workflow') return { validateIg };
        if (name === './setup') return {
          configureDotnetEnvironment() {},
          configureToolEnvironment() {},
          async runToolSetup(scriptPath, cwd, signal) {
            setupCalls.push({ scriptPath, cwd, signal });
          },
        };
        if (name.startsWith('./')) return load(localRequire.resolve(name));
        return localRequire(name);
      },
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
    return module.exports;
  }
  const extension = load(path.resolve(__dirname, '../src/extension.js'));
  extension.activate({
    subscriptions: [],
    asAbsolutePath: (name) => path.join('/test/extension', name),
  });
  return {
    run: commands.get('fhirIg.validate'),
    deactivate: extension.deactivate,
    notifications, notificationShown, pickerShown, log, outputShows, commands, diagnosticEntries, setupCalls,
  };
}

for (const outcome of ['success', 'findings', 'warning', 'error', 'cancelled']) {
  test(`another run can start while the ${outcome} notification is open`, { timeout: 5000 }, async () => {
    let calls = 0;
    const secondValidation = deferred();
    const secondStarted = deferred();
    const fixture = loadExtension(async () => {
      calls++;
      if (calls === 2) {
        secondStarted.resolve();
        return secondValidation.promise;
      }
      if (outcome === 'error') throw new Error('Build failed');
      if (outcome === 'cancelled') throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      if (outcome === 'findings') return { ...passingSummary, failed: 1 };
      if (outcome === 'warning') return { ...passingSummary, warnings: ['Restore failed'] };
      return passingSummary;
    }, { holdNotifications: true });

    const firstRun = fixture.run(configUri);
    await fixture.notificationShown.promise;
    const secondRun = fixture.run(configUri);
    await secondStarted.promise;
    assert.equal(calls, 2);

    // Dismissing the old result must not clear the second run's lock.
    fixture.notifications[0].dismiss();
    await firstRun;
    await fixture.run(configUri);
    assert.match(fixture.notifications.at(-1).message, /already running/);
    secondValidation.resolve(undefined);
    await secondRun;
  });
}

test('deactivation waits for cancellation cleanup and suppresses result dialogs', { timeout: 5000 }, async () => {
  const started = deferred();
  const cleanup = deferred();
  let signal;
  const fixture = loadExtension(async (options) => {
    signal = options.signal;
    started.resolve();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    await cleanup.promise;
    throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
  });
  const run = fixture.run(configUri);
  await started.promise;
  let deactivated = false;
  const shutdown = fixture.deactivate().then(() => { deactivated = true; });
  assert.equal(signal.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deactivated, false);
  cleanup.resolve();
  await shutdown;
  await run;
  assert.equal(fixture.notifications.length, 0);
});

test('runs the setup script and keeps diagnostics linked to generated resources', async () => {
  const file = '/test/ig/fsh-generated/resources/Bundle-bad.json';
  const fixture = loadExtension(async ({ onResult }) => {
    onResult({
      file,
      passed: false,
      output: 'Patient failed constraint',
      findings: [{
        message: 'Patient failed constraint',
        range: { start: { line: 7, character: 4 }, end: { line: 7, character: 10 } },
      }],
    });
    return { ...passingSummary, failed: 1 };
  });
  await fixture.run(configUri);
  assert.equal(fixture.setupCalls.length, 1);
  assert.equal(fixture.setupCalls[0].scriptPath, '/test/extension/install-tools.sh');
  assert.equal(fixture.setupCalls[0].cwd, '/test/ig');
  assert.deepEqual(fixture.outputShows, [true]);
  assert.equal(fixture.commands.has('fhirIg.showOutput'), false);
  assert.equal(fixture.diagnosticEntries[0].uri.fsPath, file);
  assert.equal(fixture.diagnosticEntries[0].entries[0].source, 'Firely');
  assert.match(fixture.diagnosticEntries[0].entries[0].message, /failed constraint/);
  assert.deepEqual(Array.from(fixture.diagnosticEntries[0].entries[0].range.positions), [7, 4, 7, 10]);
});

test('passes the SUSHI and output deletion choices to the workflow', async () => {
  for (const [runSushi, deleteOutput] of [[true, false], [false, true]]) {
    let received;
    const fixture = loadExtension(async (options) => {
      received = { runSushi: options.runSushi, deleteOutput: options.deleteOutput };
      return passingSummary;
    }, { runSushi, deleteOutput });
    await fixture.run(configUri);
    assert.deepEqual(received, { runSushi, deleteOutput });
  }
});

test('deactivation does not wait for a completed run notification', { timeout: 5000 }, async () => {
  const fixture = loadExtension(async () => passingSummary, { holdNotifications: true });
  const run = fixture.run(configUri);
  await fixture.notificationShown.promise;
  await fixture.deactivate();
  fixture.notifications[0].dismiss();
  await run;
});

test('deactivation cancels an open project picker without starting the workflow', { timeout: 5000 }, async () => {
  let calls = 0;
  const fixture = loadExtension(async () => { calls++; }, {
    candidates: [configUri, { scheme: 'file', fsPath: '/test/other/sushi-config.yaml' }],
  });
  const run = fixture.run();
  await fixture.pickerShown.promise;
  await fixture.deactivate();
  await run;
  assert.equal(calls, 0);
  assert.equal(fixture.notifications.length, 0);
});
