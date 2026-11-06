const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { checkCancelled } = require('./process');

function previewPaths(home = os.homedir(), environment = process.env, platform = process.platform) {
  const windows = platform === 'win32';
  const dataHome = windows
    ? environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : environment.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const root = path.join(dataHome, 'medcom-fhir-ig-helper', 'preview');
  return { root, jekyll: path.join(root, 'bin', windows ? 'jekyll.cmd' : 'jekyll') };
}

function resolveJekyllPath(configured = 'jekyll') {
  const { jekyll } = previewPaths();
  return configured === 'jekyll' && fs.existsSync(jekyll) ? jekyll : configured;
}

function confirmPreviewAction(signal, message, action) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => finish();
    function finish(choice, error) {
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(choice === action);
    }
    signal?.addEventListener('abort', abort, { once: true });
    vscode.window.showInformationMessage(
      message, action, 'Not Now',
    ).then((choice) => finish(choice), (error) => finish(undefined, error));
  });
}

function confirmPreviewSetup(signal) {
  return confirmPreviewAction(signal,
    'Jekyll could not run. Install Ruby/Jekyll and their required build dependencies for live preview? ' +
    'Installing Ruby may request administrator access. No validation tools will be installed.',
    'Install Preview Dependencies');
}

function confirmPublisherBuild(signal) {
  return confirmPreviewAction(signal,
    'The complete Publisher output or cached Jekyll inputs needed for live preview are missing. Run a full IG Publisher build now? ' +
    'This uses this guide\'s _genonce script and may take several minutes.',
    'Run Full Publisher Build');
}

let rebuildPromptId = 0;

function confirmPublisherRebuild(files, signal) {
  checkCancelled(signal);
  const action = 'Run Full genonce Rebuild';
  const message = `Live preview is out of date. Changed files: ${files.join(', ')}. These changes require a full genonce rebuild to update the live preview. ` +
    'Run it now? This uses this guide\'s _genonce script and may take several minutes.';
  return new Promise((resolve, reject) => {
    let settled = false;
    const disposables = [];
    const abort = () => finish(false);
    function finish(confirmed, error) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      disposables.forEach((disposable) => disposable.dispose());
      if (error) reject(error);
      else resolve(confirmed);
    }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      // Notifications can disappear. Keep an independent action available until
      // the user decides or the preview stops, including across editor focus changes.
      const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      disposables.push(status);
      const command = `fhirIg.confirmPublisherRebuild.${++rebuildPromptId}`;
      disposables.push(vscode.commands.registerCommand(command, () => finish(true)));
      status.name = 'IG Preview: Full rebuild required';
      status.text = `$(warning) IG Preview: ${action}`;
      status.tooltip = `${message}\nClick to run the full genonce rebuild.`;
      status.command = command;
      status.show();
      void vscode.window.showWarningMessage(message, action, 'Not Now').then((choice) => {
        if (choice === action) finish(true);
        else if (choice === 'Not Now') finish(false);
        // Hiding or dismissing the toast leaves the status bar action available.
      }, (error) => finish(false, error));
    } catch (error) {
      finish(false, error);
    }
  });
}

async function runPreviewSetup(scriptPath, cwd, signal) {
  checkCancelled(signal);
  const { root } = previewPaths();
  const windows = process.platform === 'win32';
  const executable = windows ? 'powershell.exe' : 'bash';
  const args = windows
    ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath.replace(/\.sh$/i, '.ps1'), '-InstallRoot', root]
    : [scriptPath, root];
  const task = new vscode.Task(
    { type: 'fhirIg.previewSetup' }, vscode.TaskScope.Workspace,
    'Install Ruby and Jekyll for preview', 'MedCom FHIR IG Helper',
    new vscode.ProcessExecution(executable, args, { cwd }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated,
    clear: true, showReuseMessage: false,
  };
  await runPreviewTask(task, signal, 'Preview dependency installation');
  return previewPaths().jekyll;
}

async function runPreviewTask(task, signal, description) {
  checkCancelled(signal);
  await new Promise((resolve, reject) => {
    let execution;
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      ended.dispose();
      if (error) reject(error);
      else resolve();
    }
    function abort() { execution?.terminate(); }
    const ended = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task !== task) return;
      if (signal?.aborted) {
        finish(Object.assign(new Error('Preview setup cancelled.'), { name: 'AbortError' }));
      } else if (event.exitCode === 0) finish();
      else finish(new Error(`${description} failed (exit ${event.exitCode}). See the ${task.name} terminal for details.`));
    });
    signal?.addEventListener('abort', abort, { once: true });
    vscode.tasks.executeTask(task).then((started) => {
      execution = started;
      if (signal?.aborted) execution.terminate();
    }, finish);
  });
  checkCancelled(signal);
}

module.exports = { previewPaths, resolveJekyllPath, confirmPreviewSetup, confirmPublisherBuild, confirmPublisherRebuild, runPreviewSetup, runPreviewTask };
