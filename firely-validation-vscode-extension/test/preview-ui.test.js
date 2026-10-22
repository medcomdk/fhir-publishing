const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture({
  trusted = true, validating = false, target = 'vscode', browserError = false, failed = false,
  missing = false, install = true, installError, alwaysMissing = false, customJekyll = false, installer,
  choices = [], holdPicker = false,
  buildRequired = false, buildConsent = true, buildError, builder, alwaysBuildRequired = false, buildNeedsJekyll = false,
} = {}) {
  const ready = deferred();
  const stopped = deferred();
  const messages = [];
  const opened = [];
  const log = [];
  const status = { show() {}, hide() { this.hidden = true; } };
  const config = { scheme: 'file', fsPath: '/guide/sushi-config.yaml' };
  let calls = 0;
  let prompts = 0;
  const setupCalls = [];
  const previewCalls = [];
  const pickers = [];
  let buildPrompts = 0;
  const buildCalls = [];
  const events = [];
  const vscode = {
    workspace: {
      isTrusted: trusted,
      getConfiguration: () => ({ get: (name, fallback) => {
        if (name === 'preview.jekyllPath' && customJekyll) return '/custom/jekyll';
        return fallback;
      } }),
    },
    window: {
      createOutputChannel: () => ({ clear() {}, show() {}, append: (text) => log.push(text), appendLine: (text) => log.push(text) }),
      createStatusBarItem: () => status,
      showErrorMessage: async (text) => { messages.push(text); },
      showWarningMessage: async (text) => { messages.push(text); },
      showQuickPick: async (items, options, token) => {
        pickers.push({ items, options });
        const choice = choices.length ? choices.shift() : target;
        if (holdPicker || choice === 'hold') return new Promise((resolve) => token.onCancellationRequested(() => resolve(undefined)));
        if (choice === 'cancel') return undefined;
        return choice === 'vscode' ? items.filter((item) => item.picked) : [];
      },
    },
    Uri: { parse: (url) => ({ url }) },
    ViewColumn: { Beside: 2 },
    StatusBarAlignment: { Left: 1 },
    CancellationTokenSource: class {
      constructor() {
        this.listeners = [];
        this.token = { onCancellationRequested: (listener) => this.listeners.push(listener) };
      }
      cancel() { this.listeners.forEach((listener) => listener()); }
      dispose() { this.listeners = []; }
    },
    env: {
      asExternalUri: async (uri) => ({ url: uri.url + 'forwarded' }),
      openExternal: async (uri) => { opened.push({ target: 'browser', uri }); return true; },
    },
    commands: {
      async executeCommand(command, uri, options) {
        if (browserError) throw new Error('Browser disabled');
        opened.push({ target: 'vscode', command, uri, options });
      },
    },
  };
  const file = path.resolve(__dirname, '../src/preview-ui.js');
  const localRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, AbortController,
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === './project') return { chooseConfig: async () => config };
      if (name === './preview-setup') return {
        resolveJekyllPath: (configured) => configured,
        confirmPreviewSetup: async () => { prompts++; return install; },
        confirmPublisherBuild: async () => { buildPrompts++; return buildConsent; },
        async runPreviewSetup(script, cwd, signal) {
          events.push('install');
          setupCalls.push({ script, cwd, signal });
          if (installer) await installer(signal);
          if (installError) throw new Error(installError);
          return '/managed/bin/jekyll';
        },
      };
      if (name === './preview-build') return {
        async runPublisherBuild(root, jekyllPath, signal) {
          events.push('build');
          buildCalls.push({ root, jekyllPath, signal });
          if (builder) await builder(signal);
          if (buildError) throw new Error(buildError);
        },
      };
      if (name === './preview') return {
        async checkJekyll() {
          events.push('checkJekyll');
          if (buildNeedsJekyll && setupCalls.length === 0) {
            throw Object.assign(new Error('Jekyll unavailable'), { code: 'JEKYLL_UNAVAILABLE' });
          }
        },
        async runPreview(options) {
          calls++;
          previewCalls.push({ ...options });
          if (failed) throw new Error('Missing Publisher build');
          if (buildRequired && (buildCalls.length === 0 || alwaysBuildRequired)) {
            throw Object.assign(new Error('Publisher output missing'), { code: 'PUBLISHER_BUILD_REQUIRED' });
          }
          if (missing && (calls === 1 || alwaysMissing)) {
            throw Object.assign(new Error('Jekyll unavailable'), { code: 'JEKYLL_UNAVAILABLE' });
          }
          const cancelled = new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
          await options.onReady('http://127.0.0.1:4000/');
          ready.resolve(options);
          await cancelled;
          stopped.resolve();
          throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
        },
      };
      return localRequire(name);
    },
  }, { filename: file });
  const preview = module.exports.createPreview({
    subscriptions: [], asAbsolutePath: (file) => '/extension/' + file,
  }, () => validating);
  return { preview, ready, stopped, messages, opened, log, status, setupCalls, previewCalls,
    pickers, buildCalls, events, getBuildPrompts: () => buildPrompts,
    getCalls: () => calls, getPrompts: () => prompts };
}

test('opens beside the editor after readiness and reuses the running preview', async () => {
  const { preview, ready, opened, status, getCalls } = fixture();
  await preview.start();
  await ready.promise;
  assert.equal(preview.isRunning(), true);
  assert.equal(opened[0].command, 'simpleBrowser.api.open');
  assert.equal(opened[0].options.viewColumn, 2);
  assert.match(opened[0].uri.url, /forwarded$/);
  await preview.start();
  assert.equal(getCalls(), 1);
  assert.equal(opened.length, 2);
  await preview.stop();
  assert.equal(status.hidden, true);
  assert.equal(preview.isRunning(), false);
});

test('Start and Open each show a checked VS Code option and use the choice only for that invocation', async () => {
  const { preview, ready, opened, pickers, getCalls } = fixture({ choices: ['browser', 'vscode', 'browser', 'vscode'] });
  await preview.start();
  await ready.promise;
  await preview.open();
  await preview.start();
  await preview.open();
  assert.deepEqual(opened.map((item) => item.target), ['browser', 'vscode', 'browser', 'vscode']);
  assert.equal(getCalls(), 1, 'opening again reuses the server');
  assert.equal(pickers.length, 4, 'starting opens only one picker, including the automatic opening');
  for (const picker of pickers) {
    assert.equal(picker.options.canPickMany, true);
    assert.equal(picker.items[0].label, 'Open in VS Code');
    assert.equal(picker.items[0].picked, true);
  }
  await preview.stop();
});

test('cancelling the initial checkbox picker starts no server or dependency installer', async () => {
  const { preview, getCalls, setupCalls, messages } = fixture({ choices: ['cancel'] });
  await preview.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preview.isRunning(), false);
  assert.equal(getCalls(), 0);
  assert.equal(setupCalls.length, 0);
  assert.equal(messages.length, 0);
});

test('cancelling Open leaves the preview running and does not open another view', async () => {
  const { preview, ready, opened } = fixture({ choices: ['vscode', 'cancel'] });
  await preview.start();
  await ready.promise;
  await preview.open();
  assert.equal(opened.length, 1);
  assert.equal(preview.isRunning(), true);
  await preview.stop();
});

test('stopping closes a pending checkbox picker', async () => {
  const { preview, pickers, getCalls, messages } = fixture({ holdPicker: true });
  await preview.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pickers.length, 1);
  await preview.stop();
  assert.equal(preview.isRunning(), false);
  assert.equal(getCalls(), 0);
  assert.equal(messages.length, 0);
});

test('stopping while Open is choosing a destination cancels both the picker and the server', async () => {
  const { preview, ready, opened } = fixture({ choices: ['vscode', 'hold'] });
  await preview.start();
  await ready.promise;
  const opening = preview.open();
  await preview.stop();
  await opening;
  assert.equal(opened.length, 1);
  assert.equal(preview.isRunning(), false);
});

for (const options of [{ target: 'browser' }, { browserError: true }]) {
  test(`opens externally for ${options.target || 'an unavailable VS Code browser'}`, async () => {
    const { preview, ready, opened } = fixture(options);
    await preview.start();
    await ready.promise;
    assert.equal(opened[0].target, 'browser');
    assert.equal(opened[0].uri.url, 'http://127.0.0.1:4000/');
    await preview.deactivate();
  });
}

for (const options of [{ trusted: false }, { validating: true }]) {
  test(`does not start preview when ${options.validating ? 'validation is running' : 'the workspace is untrusted'}`, async () => {
    const { preview, messages, getCalls } = fixture(options);
    await preview.start();
    assert.equal(getCalls(), 0);
    assert.equal(messages.length, 1);
    assert.equal(preview.isRunning(), false);
  });
}

test('reports startup failure and releases the session so it can be started again', async () => {
  const { preview, messages, getCalls } = fixture({ failed: true });
  await preview.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preview.isRunning(), false);
  assert.match(messages[0], /Missing Publisher build/);
  await preview.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getCalls(), 2);
});

test('deactivation awaits cleanup and suppresses cancellation dialogs', async () => {
  const { preview, ready, stopped, messages } = fixture();
  await preview.start();
  const options = await ready.promise;
  await preview.deactivate();
  await stopped.promise;
  assert.equal(options.signal.aborted, true);
  assert.equal(messages.length, 0);
  await preview.start();
  assert.equal(preview.isRunning(), false);
});

test('offers a separate preview installer and retries with its executable after consent', async () => {
  const { preview, ready, setupCalls, previewCalls, getPrompts } = fixture({ missing: true });
  await preview.start();
  await ready.promise;
  assert.equal(getPrompts(), 1);
  assert.equal(setupCalls.length, 1);
  assert.equal(setupCalls[0].script, '/extension/install-preview-tools.sh');
  assert.equal(setupCalls[0].cwd, '/guide');
  assert.equal(previewCalls[1].jekyllPath, '/managed/bin/jekyll');
  await preview.stop();
});

test('declining installation stops quietly without installing or retrying', async () => {
  const { preview, setupCalls, messages, getCalls } = fixture({ missing: true, install: false });
  await preview.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preview.isRunning(), false);
  assert.equal(setupCalls.length, 0);
  assert.equal(getCalls(), 1);
  assert.equal(messages.length, 0);
});

test('build errors and custom executable failures never trigger installation', async () => {
  for (const options of [{ failed: true }, { missing: true, customJekyll: true }]) {
    const { preview, setupCalls, getPrompts } = fixture(options);
    await preview.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getPrompts(), 0);
    assert.equal(setupCalls.length, 0);
  }
});

test('installation failures and failed verification do not cause repeated install prompts', async () => {
  for (const options of [{ installError: 'Download failed' }, { alwaysMissing: true }]) {
    const { preview, messages, getPrompts, getCalls } = fixture({ missing: true, ...options });
    await preview.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(preview.isRunning(), false);
    assert.equal(getPrompts(), 1);
    assert.equal(getCalls(), options.installError ? 1 : 2);
    assert.match(messages[0], options.installError ? /Download failed/ : /Jekyll unavailable/);
  }
});

test('stop cancels the installer and never retries the preview', async () => {
  const installing = deferred();
  const { preview, getCalls, messages } = fixture({
    missing: true,
    installer: async (signal) => {
      installing.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  await preview.start();
  await installing.promise;
  await preview.stop();
  assert.equal(preview.isRunning(), false);
  assert.equal(getCalls(), 1);
  assert.equal(messages.length, 0);
});

test('offers a full Publisher build when preview files are missing, then retries preview', async () => {
  const { preview, ready, buildCalls, getBuildPrompts, getCalls, setupCalls } = fixture({ buildRequired: true });
  await preview.start();
  await ready.promise;
  assert.equal(getBuildPrompts(), 1);
  assert.equal(buildCalls.length, 1);
  assert.equal(buildCalls[0].root, '/guide');
  assert.equal(getCalls(), 2);
  assert.equal(setupCalls.length, 0, 'an available Jekyll needs no dependency installation');
  await preview.stop();
});

test('declining a full Publisher build stops without running tools or opening a preview', async () => {
  const { preview, buildCalls, setupCalls, opened, messages, getCalls } = fixture({ buildRequired: true, buildConsent: false });
  await preview.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preview.isRunning(), false);
  assert.equal(buildCalls.length, 0);
  assert.equal(setupCalls.length, 0);
  assert.equal(opened.length, 0);
  assert.equal(messages.length, 0);
  assert.equal(getCalls(), 1);
});

test('installs and verifies a missing Jekyll before running the full Publisher build', async () => {
  const { preview, ready, buildCalls, events } = fixture({ buildRequired: true, buildNeedsJekyll: true });
  await preview.start();
  await ready.promise;
  assert.deepEqual(events, ['checkJekyll', 'install', 'checkJekyll', 'build']);
  assert.equal(buildCalls[0].jekyllPath, '/managed/bin/jekyll');
  await preview.stop();
});

test('declining Jekyll installation prevents a full build that needs Jekyll', async () => {
  const { preview, buildCalls } = fixture({ buildRequired: true, buildNeedsJekyll: true, install: false });
  await preview.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preview.isRunning(), false);
  assert.equal(buildCalls.length, 0);
});

test('failed builds and builds that leave preview files missing do not repeatedly prompt', async () => {
  for (const options of [{ buildError: 'Publisher failed' }, { alwaysBuildRequired: true }]) {
    const { preview, messages, getBuildPrompts, buildCalls } = fixture({ buildRequired: true, ...options });
    await preview.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(preview.isRunning(), false);
    assert.equal(getBuildPrompts(), 1);
    assert.equal(buildCalls.length, 1);
    assert.match(messages[0], options.buildError ? /Publisher failed/ : /Publisher output missing/);
  }
});

test('stopping during a full Publisher build cancels it and never opens preview', async () => {
  const building = deferred();
  const { preview, opened, getCalls, messages } = fixture({
    buildRequired: true,
    builder: async (signal) => {
      building.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  await preview.start();
  await building.promise;
  await preview.stop();
  assert.equal(preview.isRunning(), false);
  assert.equal(getCalls(), 1);
  assert.equal(opened.length, 0);
  assert.equal(messages.length, 0);
});
