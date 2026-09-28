const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { checkCancelled } = require('./process');

function toolPaths(home = os.homedir(), environment = process.env, platform = process.platform) {
  const windows = platform === 'win32';
  const dataHome = windows
    ? environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : environment.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const installRoot = path.join(dataHome, 'medcom-firely-validation');
  return {
    userBin: windows ? path.join(installRoot, 'bin') : path.join(home, '.local', 'bin'),
    nodeBin: windows ? path.join(installRoot, 'node') : path.join(installRoot, 'node', 'bin'),
    dotnetBin: path.join(installRoot, 'dotnet'),
  };
}

function configureDotnetEnvironment(collection, environment = process.env) {
  const { dotnetBin } = toolPaths(os.homedir(), environment);
  const executable = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
  if (!fs.existsSync(path.join(dotnetBin, executable))) return;

  environment.DOTNET_ROOT = dotnetBin;
  collection?.replace('DOTNET_ROOT', dotnetBin);
  const architecture = { x64: 'X64', ia32: 'X86', arm64: 'ARM64' }[process.arch];
  if (architecture) {
    environment[`DOTNET_ROOT_${architecture}`] = dotnetBin;
    collection?.replace(`DOTNET_ROOT_${architecture}`, dotnetBin);
  }
  if (process.platform === 'linux') {
    environment.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT = 'true';
    environment.DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY = 'false';
    collection?.replace('DOTNET_SYSTEM_GLOBALIZATION_INVARIANT', 'true');
    collection?.replace('DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY', 'false');
  }
}

function configureToolEnvironment(collection) {
  const directories = Object.values(toolPaths());
  const current = (process.env.PATH || '').split(path.delimiter);
  const missing = directories.filter((directory) => !current.includes(directory));
  if (missing.length > 0) {
    const prefix = `${missing.join(path.delimiter)}${path.delimiter}`;
    process.env.PATH = `${prefix}${process.env.PATH || ''}`;
    collection?.prepend('PATH', prefix);
  }
  configureDotnetEnvironment(collection);
}

function cancellationError() {
  const error = new Error('Validation cancelled.');
  error.name = 'AbortError';
  return error;
}

async function runToolSetup(scriptPath, cwd, signal) {
  checkCancelled(signal);
  const windows = process.platform === 'win32';
  const executable = windows ? 'powershell.exe' : 'bash';
  const args = windows
    ? [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath.replace(/\.sh$/i, '.ps1'),
    ]
    : [scriptPath, process.execPath];
  const task = new vscode.Task(
    { type: 'fhirIg.setup' },
    vscode.TaskScope.Workspace,
    'Check validation tools',
    'MedCom Firely Validation',
    new vscode.ProcessExecution(executable, args, { cwd }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    showReuseMessage: false,
  };

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

    function abort() {
      execution?.terminate();
    }

    const ended = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task !== task) return;
      if (signal?.aborted) finish(cancellationError());
      else if (event.exitCode === 0) finish();
      else finish(new Error(`Tool setup failed with exit code ${event.exitCode}. See the terminal for details.`));
    });

    signal?.addEventListener('abort', abort, { once: true });
    vscode.tasks.executeTask(task).then((started) => {
      execution = started;
      if (signal?.aborted) execution.terminate();
    }, finish);
  });
}

module.exports = {
  configureDotnetEnvironment, configureToolEnvironment, runToolSetup, toolPaths,
};
