const vscode = require('vscode');
const path = require('node:path');
const { chooseConfig } = require('./project');
const { checkCancelled } = require('./process');
const { runPreview, checkJekyll } = require('./preview');
const { resolveJekyllPath, confirmPreviewSetup, confirmPublisherBuild, runPreviewSetup } = require('./preview-setup');
const { runPublisherBuild } = require('./preview-build');

function createPreview(context, validationRunning) {
  const sessions = new Map();
  const interfaces = new Map();
  const selections = new Set();
  let shuttingDown = false;
  const decorations = new vscode.EventEmitter();

  function key(config) { return `${config.scheme}:${path.dirname(config.fsPath)}`; }

  function updateState(config) {
    const active = [...sessions.values()];
    void vscode.commands.executeCommand('setContext', 'fhirIg.previewActive', active.length > 0 || selections.size > 0);
    void vscode.commands.executeCommand('setContext', 'fhirIg.previewConfigs', active.map((session) => session.config.fsPath));
    void vscode.commands.executeCommand('setContext', 'fhirIg.previewRunningConfigs', active
      .filter((session) => session.url && !session.controller.signal.aborted)
      .map((session) => session.config.fsPath));
    if (config) decorations.fire(config);
  }

  const provider = vscode.window.registerFileDecorationProvider({
    onDidChangeFileDecorations: decorations.event,
    provideFileDecoration(uri) {
      const session = sessions.get(key(uri));
      if (session?.url && !session.controller.signal.aborted && uri.fsPath === session.config.fsPath) {
        return { badge: '▶', tooltip: `IG live preview running: ${session.url}`,
          color: new vscode.ThemeColor('textLink.foreground'), propagate: false };
      }
      return undefined;
    },
  });
  context.subscriptions.push(decorations, provider);
  updateState();

  function showStatus(session, text) {
    session.status.text = `${text} (${path.basename(path.dirname(session.config.fsPath))}) — $(debug-stop) Stop`;
    session.status.show();
  }

  function sessionInterface(config) {
    const id = key(config);
    if (!interfaces.has(id)) {
      const root = path.dirname(config.fsPath);
      const output = vscode.window.createOutputChannel(`MedCom IG Preview: ${root}`);
      const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      status.name = `MedCom IG Live Preview: ${root}`;
      status.command = { command: 'fhirIg.stopPreview', title: 'Stop IG live preview', arguments: [config] };
      context.subscriptions.push(output, status);
      interfaces.set(id, { output, status });
    }
    return interfaces.get(id);
  }

  async function selectConfig(uri, title) {
    const controller = new AbortController();
    const selection = { controller };
    selections.add(selection);
    updateState();
    selection.completion = chooseConfig(uri, controller.signal, title);
    try {
      const config = await selection.completion;
      checkCancelled(controller.signal);
      return config;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return undefined;
    } finally {
      selections.delete(selection);
      updateState();
    }
  }

  async function selectedSession(uri) {
    if (!uri && sessions.size === 1) return sessions.values().next().value;
    if (!uri && sessions.size === 0) return undefined;
    const config = await selectConfig(uri, 'Select the implementation guide preview');
    return config && sessions.get(key(config));
  }

  async function openSession(session, target) {
    if (!session?.url || session.controller.signal.aborted) return;
    const { output } = session;
    const uri = vscode.Uri.parse(session.url);
    if (target === 'vscode') {
      try {
        const resolved = await vscode.env.asExternalUri(uri);
        if (session.controller.signal.aborted) return;
        await vscode.commands.executeCommand('simpleBrowser.api.open', resolved, {
          viewColumn: vscode.ViewColumn.Beside,
          preserveFocus: true,
        });
        return;
      } catch (error) {
        output.appendLine(`Could not open the VS Code preview: ${error.message}. Opening the browser instead.`);
      }
    }
    if (session.controller.signal.aborted) return;
    if (!await vscode.env.openExternal(uri)) {
      throw new Error(`Could not open the browser. Preview is running at ${session.url}`);
    }
  }

  async function openPreview(target = 'browser', uri) {
    const session = await selectedSession(uri);
    if (!session?.url || session.controller.signal.aborted) return;
    try {
      await openSession(session, target);
    } catch (error) {
      if (!session.controller.signal.aborted) throw error;
    }
  }

  async function execute(session) {
    const { config, output, status } = session;
    const { signal } = session.controller;
    const settings = vscode.workspace.getConfiguration('fhirIg', config);
    output.clear();
    output.appendLine(`Live IG preview: ${path.dirname(config.fsPath)}`);
    output.show(true);
    status.tooltip = `Live preview: ${path.dirname(config.fsPath)}\nClick to stop the IG live preview`;
    showStatus(session, '$(sync~spin) IG Preview: Starting');
    const configuredJekyll = settings.get('preview.jekyllPath', 'jekyll');
    const options = {
      root: path.dirname(config.fsPath),
      jekyllPath: resolveJekyllPath(configuredJekyll),
      port: settings.get('preview.port', 4000),
      signal,
      log: (text) => output.append(text),
      onRefresh: (refreshing) => {
        showStatus(session, refreshing ? '$(sync~spin) IG Preview: Refreshing text'
          : '$(radio-tower) IG Preview: Running');
      },
      rebuild: async (buildSignal) => {
        showStatus(session, '$(sync~spin) IG Preview: Building with Publisher');
        try {
          await runPublisherBuild(options.root, options.jekyllPath, buildSignal);
        } finally {
          if (!buildSignal.aborted) showStatus(session, '$(radio-tower) IG Preview: Running');
        }
      },
      onReady: async (url) => {
        checkCancelled(signal);
        session.url = url;
        updateState(config);
        status.tooltip = `Live preview: ${options.root}\n${url}\nClick to stop the IG live preview`;
        showStatus(session, '$(radio-tower) IG Preview: Running');
        try {
          await openSession(session, session.target);
        } catch (error) {
          output.appendLine(error.message);
          if (!signal.aborted && !shuttingDown) void vscode.window.showWarningMessage(error.message);
        }
      },
    };
    let installed = false;
    let built = false;
    async function installDependencies(error) {
      // An explicitly configured executable belongs to the user; preserve it.
      if (error.code !== 'JEKYLL_UNAVAILABLE' || configuredJekyll !== 'jekyll' || installed) throw error;
      output.appendLine(error.message);
      showStatus(session, '$(tools) IG Preview: Setup required');
      if (!await confirmPreviewSetup(signal)) return false;
      checkCancelled(signal);
      installed = true;
      showStatus(session, '$(sync~spin) IG Preview: Installing dependencies');
      options.jekyllPath = await runPreviewSetup(
        context.asAbsolutePath('install-preview-tools.sh'), options.root, signal,
      );
      checkCancelled(signal);
      output.show(true);
      showStatus(session, '$(sync~spin) IG Preview: Starting');
      return true;
    }
    while (true) {
      try {
        await runPreview(options);
        return;
      } catch (error) {
        checkCancelled(signal);
        if (error.code === 'PUBLISHER_BUILD_REQUIRED' && !built) {
          output.appendLine(error.message);
          if (!await confirmPublisherBuild(signal)) return;
          checkCancelled(signal);
          // Ensure Jekyll is available before asking Publisher to render the IG.
          try {
            await checkJekyll(options);
          } catch (dependencyError) {
            if (!await installDependencies(dependencyError)) return;
            await checkJekyll(options);
          }
          built = true;
          showStatus(session, '$(sync~spin) IG Preview: Building with Publisher');
          await runPublisherBuild(options.root, options.jekyllPath, signal);
          checkCancelled(signal);
          output.show(true);
          showStatus(session, '$(sync~spin) IG Preview: Starting');
        } else if (!await installDependencies(error)) return;
      }
    }
  }

  async function start(uri, target = 'browser') {
    if (shuttingDown) return;
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showErrorMessage('Trust this workspace before running live preview.');
      return;
    }
    const config = await selectConfig(uri, 'Select the implementation guide to preview');
    if (!config || shuttingDown) return;
    if (config.scheme !== 'file') {
      throw new Error('Live preview requires a local, WSL, SSH, or container filesystem workspace.');
    }
    const id = key(config);
    const existing = sessions.get(id);
    if (existing) {
      if (existing.url) await openSession(existing, target);
      else existing.output.show(true);
      return;
    }
    if (validationRunning()) {
      await vscode.window.showWarningMessage('Wait for validation to finish before starting live preview.');
      return;
    }
    const session = { controller: new AbortController(), target, config, ...sessionInterface(config) };
    const { output, status } = session;
    sessions.set(id, session);
    updateState();
    status.tooltip = 'Click to stop the IG live preview';
    showStatus(session, '$(sync~spin) IG Preview: Starting');
    session.completion = execute(session).catch((error) => {
      if (!session.controller.signal.aborted) {
        output.appendLine(error.message);
        return error;
      }
      return undefined;
    }).finally(() => {
      if (sessions.get(id) === session) {
        sessions.delete(id);
        status.hide();
        updateState(config);
      }
      output.appendLine('Preview stopped.');
    });
    // The command returns once launched; each session owns its server lifetime.
    void session.completion.then((error) => {
      if (error && !shuttingDown) void vscode.window.showErrorMessage(error.message, 'Show Output').then((action) => {
        if (action === 'Show Output') output.show(true);
      });
    });
  }

  async function stopSession(session) {
    if (!session) return;
    session.status.text = '$(sync~spin) IG Preview: Stopping';
    session.status.tooltip = 'Waiting for the IG live preview to stop';
    session.controller.abort();
    updateState(session.config);
    await session.completion;
  }

  async function stop(uri) {
    if (!uri) {
      const pending = [...selections];
      pending.forEach((selection) => selection.controller.abort());
      await Promise.allSettled(pending.map((selection) => selection.completion));
    }
    await stopSession(await selectedSession(uri));
  }

  return {
    start, stop, open: openPreview,
    isRunning: () => sessions.size > 0 || selections.size > 0,
    async deactivate() {
      shuttingDown = true;
      const pending = [...selections];
      pending.forEach((selection) => selection.controller.abort());
      await Promise.allSettled([
        ...pending.map((selection) => selection.completion),
        ...[...sessions.values()].map(stopSession),
      ]);
    },
  };
}

module.exports = { createPreview };
