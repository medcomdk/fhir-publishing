const vscode = require('vscode');
const path = require('node:path');
const { chooseConfig } = require('./project');
const { checkCancelled } = require('./process');
const { runPreview, checkJekyll } = require('./preview');
const { resolveJekyllPath, confirmPreviewSetup, confirmPublisherBuild, runPreviewSetup } = require('./preview-setup');
const { runPublisherBuild } = require('./preview-build');

async function choosePreviewTarget(signal) {
  checkCancelled(signal);
  const cancellation = new vscode.CancellationTokenSource();
  const abort = () => cancellation.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const selection = await vscode.window.showQuickPick([
      { label: 'Open in VS Code', picked: false, description: 'Select to open in VS Code instead of your default browser' },
    ], {
      canPickMany: true,
      title: 'Live preview',
      placeHolder: 'Enter to continue. Use Tab and Space to toggle the checkbox.',
    }, cancellation.token);
    checkCancelled(signal);
    if (selection === undefined) return undefined;
    return selection.length > 0 ? 'vscode' : 'browser';
  } finally {
    signal.removeEventListener('abort', abort);
    cancellation.dispose();
  }
}

function createPreview(context, validationRunning) {
  const output = vscode.window.createOutputChannel('MedCom IG Preview');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = 'MedCom IG Live Preview';
  status.command = 'fhirIg.stopPreview';
  status.tooltip = 'Click to stop the IG live preview';
  context.subscriptions.push(output, status);
  let active;
  let shuttingDown = false;
  void vscode.commands.executeCommand('setContext', 'fhirIg.previewActive', false);

  function showStatus(text) {
    status.text = `${text} — $(debug-stop) Stop`;
    status.show();
  }

  async function openSession(session, target) {
    if (!session?.url || session.controller.signal.aborted) return;
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

  async function openPreview() {
    const session = active;
    if (!session?.url || session.controller.signal.aborted) return;
    try {
      const target = await choosePreviewTarget(session.controller.signal);
      if (target) await openSession(session, target);
    } catch (error) {
      if (!session.controller.signal.aborted) throw error;
    }
  }

  async function execute(uri, session) {
    const { signal } = session.controller;
    const config = await chooseConfig(uri, signal, 'Select the implementation guide to preview');
    checkCancelled(signal);
    if (!config) return;
    if (config.scheme !== 'file') {
      throw new Error('Live preview requires a local, WSL, SSH, or container filesystem workspace.');
    }
    session.target = await choosePreviewTarget(signal);
    if (!session.target) return;
    const settings = vscode.workspace.getConfiguration('fhirIg', config);
    output.clear();
    output.appendLine(`Live IG preview: ${path.dirname(config.fsPath)}`);
    output.show(true);
    status.tooltip = `Live preview: ${path.dirname(config.fsPath)}\nClick to stop the IG live preview`;
    showStatus('$(sync~spin) IG Preview: Starting');
    const configuredJekyll = settings.get('preview.jekyllPath', 'jekyll');
    const options = {
      root: path.dirname(config.fsPath),
      jekyllPath: resolveJekyllPath(configuredJekyll),
      port: settings.get('preview.port', 4000),
      signal,
      log: (text) => output.append(text),
      onReady: async (url) => {
        checkCancelled(signal);
        session.url = url;
        status.tooltip = `Live preview: ${options.root}\n${url}\nClick to stop the IG live preview`;
        showStatus('$(radio-tower) IG Preview: Running');
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
      showStatus('$(tools) IG Preview: Setup required');
      if (!await confirmPreviewSetup(signal)) return false;
      checkCancelled(signal);
      installed = true;
      showStatus('$(sync~spin) IG Preview: Installing dependencies');
      options.jekyllPath = await runPreviewSetup(
        context.asAbsolutePath('install-preview-tools.sh'), options.root, signal,
      );
      checkCancelled(signal);
      output.show(true);
      showStatus('$(sync~spin) IG Preview: Starting');
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
          showStatus('$(sync~spin) IG Preview: Building with Publisher');
          await runPublisherBuild(options.root, options.jekyllPath, signal);
          checkCancelled(signal);
          output.show(true);
          showStatus('$(sync~spin) IG Preview: Starting');
        } else if (!await installDependencies(error)) return;
      }
    }
  }

  async function start(uri) {
    if (shuttingDown) return;
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showErrorMessage('Trust this workspace before running live preview.');
      return;
    }
    if (active) {
      if (active.url) await openPreview();
      else output.show(true);
      return;
    }
    if (validationRunning()) {
      await vscode.window.showWarningMessage('Wait for validation to finish before starting live preview.');
      return;
    }
    const session = { controller: new AbortController() };
    active = session;
    void vscode.commands.executeCommand('setContext', 'fhirIg.previewActive', true);
    status.tooltip = 'Click to stop the IG live preview';
    showStatus('$(sync~spin) IG Preview: Starting');
    session.completion = execute(uri, session).catch((error) => {
      if (!session.controller.signal.aborted) {
        output.appendLine(error.message);
        return error;
      }
      return undefined;
    }).finally(() => {
      if (active === session) {
        active = undefined;
        status.hide();
        void vscode.commands.executeCommand('setContext', 'fhirIg.previewActive', false);
      }
      output.appendLine('Preview stopped.');
    });
    // The command returns once launched; the session owns the server lifetime.
    void session.completion.then((error) => {
      if (error && !shuttingDown) void vscode.window.showErrorMessage(error.message, 'Show Output').then((action) => {
        if (action === 'Show Output') output.show(true);
      });
    });
  }

  async function stop() {
    const session = active;
    if (!session) return;
    status.text = '$(sync~spin) IG Preview: Stopping';
    status.tooltip = 'Waiting for the IG live preview to stop';
    session.controller.abort();
    await session.completion;
  }

  return {
    start, stop, open: openPreview,
    isRunning: () => !!active,
    async deactivate() {
      shuttingDown = true;
      await stop();
    },
  };
}

module.exports = { createPreview };
