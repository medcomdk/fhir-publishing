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
  const root = path.join(dataHome, 'medcom-ig-preview');
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
    'The Publisher files needed for live preview are missing. Run a full IG Publisher build now? ' +
    'This uses this guide\'s _genonce script and may take several minutes.',
    'Run Full Publisher Build');
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
    'Install Ruby and Jekyll for preview', 'MedCom IG Preview',
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

module.exports = { previewPaths, resolveJekyllPath, confirmPreviewSetup, confirmPublisherBuild, runPreviewSetup, runPreviewTask };
