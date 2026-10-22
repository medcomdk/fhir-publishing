const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { checkCancelled } = require('./process');
const { requirePreviewBuild } = require('./preview');
const { runPreviewTask } = require('./preview-setup');

async function runPublisherBuild(root, jekyllPath, signal) {
  checkCancelled(signal);
  const windows = process.platform === 'win32';
  const script = windows ? '_genonce.bat' : '_genonce.sh';
  try {
    if (!(await fs.stat(path.join(root, script))).isFile()) throw new Error('Not a file');
  } catch (error) {
    throw new Error(`Cannot run a full Publisher build: ${script} was not found in ${root}. Add the guide's Publisher build script and retry preview.`, { cause: error });
  }
  // Make the preview's private Jekyll available to Publisher without changing
  // the user's environment or installing any validation tools.
  const env = path.isAbsolute(jekyllPath)
    ? { PATH: `${path.dirname(jekyllPath)}${windows ? ';' : ':'}${process.env.PATH || ''}` }
    : undefined;
  const task = new vscode.Task(
    { type: 'fhirIg.publisherBuild' }, vscode.TaskScope.Workspace,
    'Full IG Publisher build', 'MedCom IG Preview',
    new vscode.ProcessExecution(windows ? 'cmd.exe' : 'bash',
      windows ? ['/d', '/c', script] : [`./${script}`], { cwd: root, env }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated,
    clear: true, showReuseMessage: false,
  };
  await runPreviewTask(task, signal, 'Full Publisher build');
  checkCancelled(signal);
  try {
    await requirePreviewBuild(root);
  } catch (error) {
    throw new Error('The Publisher build finished, but the files needed for preview are still missing. ' + error.message, { cause: error });
  }
}

module.exports = { runPublisherBuild };
