const vscode = require('vscode');
const path = require('node:path');
const { checkCancelled } = require('./process');

const CONFIG_PATTERN = '**/sushi-config.{yaml,yml}';
const EXCLUDED_DIRECTORIES = '**/{node_modules,.git,fsh-generated,output,temp,input-cache,template}/**';

function containsFile(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function nearestConfig(candidates, fileUri) {
  if (!fileUri) {
    return undefined;
  }
  return candidates
    .filter((candidate) => containsFile(path.dirname(candidate.fsPath), fileUri.fsPath))
    .sort((a, b) => b.fsPath.length - a.fsPath.length)[0];
}

async function pickConfig(candidates, signal) {
  const cancellation = new vscode.CancellationTokenSource();
  const cancelSelection = () => cancellation.cancel();
  signal.addEventListener('abort', cancelSelection, { once: true });
  try {
    checkCancelled(signal);
    const selection = await vscode.window.showQuickPick(
      candidates.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
      { placeHolder: 'Select the implementation guide to build and validate' },
      cancellation.token,
    );
    return selection?.uri;
  } finally {
    signal.removeEventListener('abort', cancelSelection);
    cancellation.dispose();
  }
}

async function chooseConfig(uri, signal) {
  checkCancelled(signal);
  if (!vscode.workspace.workspaceFolders?.length) {
    throw new Error('Open an implementation guide folder first.');
  }
  if (uri && /^sushi-config\.ya?ml$/.test(path.basename(uri.fsPath))) {
    return uri;
  }
  const candidates = await vscode.workspace.findFiles(CONFIG_PATTERN, EXCLUDED_DIRECTORIES);
  checkCancelled(signal);
  if (candidates.length === 0) {
    throw new Error('No sushi-config.yaml or sushi-config.yml was found in the workspace.');
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  const currentFile = uri || vscode.window.activeTextEditor?.document.uri;
  return nearestConfig(candidates, currentFile) || pickConfig(candidates, signal);
}

function readSettings(configUri) {
  const settings = vscode.workspace.getConfiguration('fhirIg', configUri);
  return {
    firelyPath: settings.get('firelyPath', 'fhir'),
    sushiPath: settings.get('sushiPath', 'sushi'),
  };
}

module.exports = { chooseConfig, readSettings };
