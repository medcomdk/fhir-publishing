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
  trusted = true, validating = false, browserError = false, failed = false,
  missing = false, install = true, installError, alwaysMissing = false, customJekyll = false, installer,
  cleanup, readyGate, chooser,
  buildRequired = false, buildConsent = true, buildError, builder, alwaysBuildRequired = false, buildNeedsJekyll = false,
} = {}) {
  const ready = deferred();
  const stopped = deferred();
  const messages = [];
  const opened = [];
  const log = [];
  function makeStatus() { return { show() { this.hidden = false; }, hide() { this.hidden = true; } }; }
  const status = makeStatus();
  const statuses = [];
  const outputs = [];
  const contexts = new Map();
  const config = { scheme: 'file', fsPath: '/guide/sushi-config.yaml' };
  let calls = 0;
  let started = 0;
  let prompts = 0;
  const setupCalls = [];
  const previewCalls = [];
  const decorationEvents = [];
  let decorationProvider;
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
      createOutputChannel: (name) => {
        const entries = [];
        const output = { name, entries, clear() {}, show() {},
          append: (text) => { entries.push(text); log.push(text); },
          appendLine: (text) => { entries.push(text); log.push(text); } };
        outputs.push(output);
        return output;
      },
      createStatusBarItem: () => {
        const item = statuses.length === 0 ? status : makeStatus();
        statuses.push(item);
        return item;
      },
      showErrorMessage: async (text) => { messages.push(text); },
      showWarningMessage: async (text) => { messages.push(text); },
      showQuickPick: () => assert.fail('Preview must not prompt for a destination'),
      registerFileDecorationProvider(provider) {
        decorationProvider = provider;
        return { dispose() {} };
      },
    },
    Uri: { parse: (url) => ({ url }) },
    ViewColumn: { Beside: 2 },
    StatusBarAlignment: { Left: 1 },
    EventEmitter: class {
      event = () => {};
      fire(uri) { decorationEvents.push(uri); }
      dispose() {}
    },
    ThemeColor: class { constructor(id) { this.id = id; } },
    env: {
      asExternalUri: async (uri) => ({ url: uri.url + 'forwarded' }),
      openExternal: async (uri) => { opened.push({ target: 'browser', uri }); return true; },
    },
    commands: {
      async executeCommand(command, uri, options) {
        if (command === 'setContext') {
          contexts.set(uri, options);
          return;
        }
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
      if (name === './project') return { chooseConfig: chooser || (async (uri) => uri || config) };
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
          if (builder) await builder(signal, root);
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
          if (failed === true || failed === options.root) throw new Error('Missing Publisher build');
          if (buildRequired && (buildCalls.length === 0 || alwaysBuildRequired)) {
            throw Object.assign(new Error('Publisher output missing'), { code: 'PUBLISHER_BUILD_REQUIRED' });
          }
          if (missing && (calls === 1 || alwaysMissing)) {
            throw Object.assign(new Error('Jekyll unavailable'), { code: 'JEKYLL_UNAVAILABLE' });
          }
          const cancelled = new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
          const port = 4000 + started++ * 2;
          if (readyGate) await readyGate;
          await options.onReady(`http://127.0.0.1:${port}/`);
          ready.resolve(options);
          await cancelled;
          if (cleanup) await cleanup;
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
  return { preview, ready, stopped, messages, opened, log, status, contexts, setupCalls, previewCalls,
    config, statuses, outputs, decorationProvider, decorationEvents, buildCalls, events, getBuildPrompts: () => buildPrompts,
    getCalls: () => calls, getPrompts: () => prompts };
}

test('opens beside the editor after readiness and reuses the running preview', async () => {
  const { preview, ready, opened, status, getCalls } = fixture();
  await preview.start(undefined, 'vscode');
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

test('Start and Open use their explicit destinations without prompting and reuse the server', async () => {
  const { preview, ready, opened, getCalls } = fixture();
  await preview.start();
  await ready.promise;
  await preview.open('vscode');
  await preview.start(undefined, 'browser');
  await preview.open('vscode');
  assert.deepEqual(opened.map((item) => item.target), ['browser', 'vscode', 'browser', 'vscode']);
  assert.equal(getCalls(), 1);
  await preview.stop();
});

test('shows running and stopping status and keeps Stop available until cleanup finishes', async () => {
  const cleanup = deferred();
  const gate = deferred();
  const { preview, ready, status, contexts } = fixture({ cleanup: cleanup.promise, readyGate: gate.promise });
  assert.equal(contexts.get('fhirIg.previewActive'), false);
  await preview.start();
  assert.equal(contexts.get('fhirIg.previewActive'), true);
  assert.match(status.text, /Starting.*Stop/);
  gate.resolve();
  await ready.promise;
  assert.equal(status.hidden, false);
  assert.match(status.text, /IG Preview: Running.*Stop/);
  assert.equal(status.command.command, 'fhirIg.stopPreview');
  assert.equal(status.command.arguments[0].fsPath, '/guide/sushi-config.yaml');
  assert.match(status.tooltip, /\/guide/);
  assert.match(status.tooltip, /http:\/\/127.0.0.1:4000\//);
  const stopping = preview.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(status.text, /IG Preview: Stopping/);
  assert.equal(status.hidden, false);
  assert.equal(contexts.get('fhirIg.previewActive'), true);
  cleanup.resolve();
  await stopping;
  assert.equal(status.hidden, true);
  assert.equal(contexts.get('fhirIg.previewActive'), false);
});

for (const options of [{ target: 'browser' }, { target: 'vscode', browserError: true }]) {
  test(`opens externally for ${options.target || 'an unavailable VS Code browser'}`, async () => {
    const { preview, ready, opened } = fixture(options);
    await preview.start(undefined, options.target);
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
  const { preview, messages, getCalls, status, contexts } = fixture({ failed: true });
  await preview.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preview.isRunning(), false);
  assert.equal(status.hidden, true);
  assert.equal(contexts.get('fhirIg.previewActive'), false);
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

test('decorates only the previewed config after readiness and clears the badge on Stop', async () => {
  const cleanup = deferred();
  const { preview, ready, config, decorationProvider, decorationEvents } = fixture({ cleanup: cleanup.promise });
  assert.equal(decorationProvider.provideFileDecoration(config), undefined);
  const starting = preview.start(config);
  assert.equal(decorationProvider.provideFileDecoration(config), undefined);
  await starting;
  await ready.promise;
  const badge = decorationProvider.provideFileDecoration({ ...config });
  assert.equal(badge.badge, '▶');
  assert.equal(badge.color.id, 'textLink.foreground');
  assert.match(badge.tooltip, /http:\/\/127.0.0.1:4000/);
  assert.equal(badge.propagate, false);
  assert.equal(decorationProvider.provideFileDecoration({ ...config, fsPath: '/other/sushi-config.yaml' }), undefined);
  assert.equal(decorationProvider.provideFileDecoration({ ...config, scheme: 'untitled' }), undefined);
  assert.equal(decorationProvider.provideFileDecoration({ ...config, fsPath: '/guide/input/pagecontent/index.md' }), undefined);
  assert.deepEqual(decorationEvents, [config]);
  const stopping = preview.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(decorationProvider.provideFileDecoration(config), undefined);
  assert.deepEqual(decorationEvents, [config, config]);
  cleanup.resolve();
  await stopping;
  assert.deepEqual(decorationEvents, [config, config, config]);
});

test('automatic rebuild uses the Publisher pipeline without another build prompt or browser opening', async () => {
  const building = deferred();
  const built = deferred();
  const { preview, ready, buildCalls, getBuildPrompts, opened, status } = fixture({
    builder: async () => { building.resolve(); await built.promise; },
  });
  await preview.start();
  const options = await ready.promise;
  const rebuilding = options.rebuild(options.signal);
  await building.promise;
  assert.match(status.text, /Building with Publisher/);
  assert.equal(buildCalls.length, 1);
  assert.equal(buildCalls[0].root, '/guide');
  assert.equal(buildCalls[0].jekyllPath, 'jekyll');
  assert.equal(buildCalls[0].signal, options.signal);
  assert.equal(getBuildPrompts(), 0);
  built.resolve();
  await rebuilding;
  assert.match(status.text, /IG Preview: Running/);
  assert.equal(opened.length, 1);
  await preview.stop();
});

test('right-click menus expose separate Browser and VS Code actions for both config extensions', () => {
  const manifest = require('../package.json');
  for (const menu of ['explorer/context', 'editor/context', 'editor/title/context']) {
    for (const command of ['fhirIg.startPreview', 'fhirIg.startPreviewInVsCode', 'fhirIg.openPreview', 'fhirIg.openPreviewInVsCode']) {
      const entry = manifest.contributes.menus[menu].find((item) => item.command === command);
      assert.ok(entry, `${command} missing from ${menu}`);
      assert.match(entry.when, /sushi-config.yaml/);
      assert.match(entry.when, /sushi-config.yml/);
      const contribution = manifest.contributes.commands.find((item) => item.command === command);
      assert.match(contribution.title, command.endsWith('InVsCode') ? /in VS Code$/ : /in Browser$/);
    }
  }
});

const otherConfig = { scheme: 'file', fsPath: '/other/sushi-config.yml' };

async function tick() { await new Promise((resolve) => setImmediate(resolve)); }

test('two IGs have separate URLs, menus, statuses, logs and running badges', async (t) => {
  const { preview, config, opened, previewCalls, statuses, outputs, contexts, decorationProvider } = fixture();
  t.after(() => preview.deactivate());
  await preview.start(config);
  await tick();
  assert.deepEqual(Array.from(contexts.get('fhirIg.previewConfigs')), [config.fsPath]);
  await preview.start(otherConfig, 'vscode');
  await tick();
  assert.equal(previewCalls.length, 2);
  assert.equal(previewCalls[0].root, '/guide');
  assert.equal(previewCalls[1].root, '/other');
  assert.equal(opened[0].uri.url, 'http://127.0.0.1:4000/');
  assert.equal(opened[1].uri.url, 'http://127.0.0.1:4002/forwarded');
  assert.match(decorationProvider.provideFileDecoration(config).tooltip, /4000/);
  assert.match(decorationProvider.provideFileDecoration(otherConfig).tooltip, /4002/);
  assert.deepEqual(Array.from(contexts.get('fhirIg.previewConfigs')), [config.fsPath, otherConfig.fsPath]);
  assert.deepEqual(Array.from(contexts.get('fhirIg.previewRunningConfigs')), [config.fsPath, otherConfig.fsPath]);
  assert.equal(statuses.length, 2);
  assert.equal(statuses[0].command.arguments[0], config);
  assert.equal(statuses[1].command.arguments[0], otherConfig);
  previewCalls[0].log('Guide A output');
  previewCalls[1].log('Guide B output');
  assert.ok(outputs[0].entries.includes('Guide A output'));
  assert.ok(!outputs[0].entries.includes('Guide B output'));
  assert.ok(outputs[1].entries.includes('Guide B output'));
  assert.ok(!outputs[1].entries.includes('Guide A output'));
  await preview.open('browser', otherConfig);
  assert.equal(opened.at(-1).uri.url, 'http://127.0.0.1:4002/');
  await preview.start(config, 'vscode');
  assert.equal(opened.at(-1).uri.url, 'http://127.0.0.1:4000/forwarded');
  assert.equal(previewCalls.length, 2, 'starting the same guide reuses only its own session');
  await preview.stop(config);
  assert.equal(previewCalls[0].signal.aborted, true);
  assert.equal(previewCalls[1].signal.aborted, false);
  assert.equal(statuses[0].hidden, true);
  assert.equal(statuses[1].hidden, false);
  assert.equal(decorationProvider.provideFileDecoration(config), undefined);
  assert.ok(decorationProvider.provideFileDecoration(otherConfig));
  assert.equal(contexts.get('fhirIg.previewActive'), true);
  assert.deepEqual(Array.from(contexts.get('fhirIg.previewConfigs')), [otherConfig.fsPath]);
  await preview.start(config);
  await tick();
  assert.equal(previewCalls.length, 3);
  assert.equal(opened.at(-1).uri.url, 'http://127.0.0.1:4004/');
  assert.equal(outputs.length, 2, 'restarting reuses the guide output channel');
});

test('Open and Stop on an inactive guide never target another running guide', async (t) => {
  const { preview, config, opened, previewCalls } = fixture();
  t.after(() => preview.deactivate());
  await preview.start(config);
  await tick();
  await preview.open('browser', otherConfig);
  await preview.stop(otherConfig);
  assert.equal(opened.length, 1);
  assert.equal(previewCalls[0].signal.aborted, false);
});

test('concurrent Start commands create only one session for each guide', async (t) => {
  const { preview, config, previewCalls } = fixture();
  t.after(() => preview.deactivate());
  await Promise.all([preview.start(config), preview.start(config), preview.start(otherConfig)]);
  await tick();
  assert.equal(previewCalls.length, 2);
  assert.equal(new Set(previewCalls.map((options) => options.root)).size, 2);
});

test('a failed guide startup leaves the other preview running and decorated', async (t) => {
  const { preview, config, previewCalls, contexts, decorationProvider } = fixture({ failed: '/other' });
  t.after(() => preview.deactivate());
  await preview.start(config);
  await tick();
  await preview.start(otherConfig);
  await tick();
  assert.equal(previewCalls[0].signal.aborted, false);
  assert.ok(decorationProvider.provideFileDecoration(config));
  assert.equal(decorationProvider.provideFileDecoration(otherConfig), undefined);
  assert.deepEqual(Array.from(contexts.get('fhirIg.previewConfigs')), [config.fsPath]);
});

test('deactivation cancels all IG sessions and clears all indicators', async () => {
  const { preview, config, previewCalls, contexts, decorationProvider, statuses } = fixture();
  await preview.start(config);
  await preview.start(otherConfig);
  await tick();
  await preview.deactivate();
  assert.ok(previewCalls.every((options) => options.signal.aborted));
  assert.ok(statuses.every((status) => status.hidden));
  assert.equal(decorationProvider.provideFileDecoration(config), undefined);
  assert.equal(decorationProvider.provideFileDecoration(otherConfig), undefined);
  assert.equal(contexts.get('fhirIg.previewActive'), false);
  assert.deepEqual(Array.from(contexts.get('fhirIg.previewConfigs')), []);
  assert.deepEqual(Array.from(contexts.get('fhirIg.previewRunningConfigs')), []);
  assert.equal(preview.isRunning(), false);
});

test('preview menus use the selected file and the title icon is a broadcast symbol', () => {
  const manifest = require('../package.json');
  for (const menu of ['explorer/context', 'editor/context', 'editor/title/context']) {
    for (const entry of manifest.contributes.menus[menu].filter((item) => item.command.includes('Preview'))) {
      assert.ok(!entry.when.includes('fhirIg.previewActive'));
      assert.ok(entry.when.includes(entry.command.includes('startPreview')
        ? 'resourcePath not in fhirIg.previewConfigs' : 'resourcePath in fhirIg.previewConfigs'));
    }
  }
  assert.equal(manifest.contributes.commands.find((item) => item.command === 'fhirIg.openPreview').icon, '$(radio-tower)');
  assert.match(manifest.contributes.menus['editor/title'][0].when, /resourcePath in fhirIg.previewRunningConfigs/);
});

test('deactivation cancels a pending guide selection without starting a server', async () => {
  const choosing = deferred();
  const { preview, previewCalls, contexts } = fixture({
    chooser: async (_uri, signal) => {
      choosing.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return undefined;
    },
  });
  const starting = preview.start();
  await choosing.promise;
  await preview.deactivate();
  await starting;
  assert.equal(previewCalls.length, 0);
  assert.equal(preview.isRunning(), false);
  assert.equal(contexts.get('fhirIg.previewActive'), false);
});

test('fast text refresh reports Jekyll activity without running the Publisher build callback', async () => {
  const { preview, ready, status, buildCalls, opened } = fixture();
  await preview.start();
  const options = await ready.promise;
  options.onRefresh(true);
  assert.match(status.text, /Refreshing text/);
  assert.equal(buildCalls.length, 0);
  options.onRefresh(false);
  assert.match(status.text, /IG Preview: Running/);
  assert.equal(opened.length, 1);
  await preview.stop();
});
