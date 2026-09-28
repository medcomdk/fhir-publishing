const vscode = require('vscode');
const path = require('node:path');

function prepareOutput(configUri, output, diagnostics) {
  const root = path.dirname(configUri.fsPath);
  const resourceRoot = path.join(root, 'fsh-generated', 'resources') + path.sep;
  diagnostics.forEach((file) => {
    if (file.fsPath.startsWith(resourceRoot)) {
      diagnostics.delete(file);
    }
  });
  output.clear();
  output.appendLine(`Building and validating ${root}`);
}

function recordResult(diagnostics, { file, passed, output, findings = [] }) {
  if (passed) {
    return;
  }
  const issues = findings.length > 0 ? findings : [{ message: output }];
  const entries = issues.map((issue) => {
    const { start = { line: 0, character: 0 }, end = { line: 0, character: 1 } } = issue.range || {};
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(start.line, start.character, end.line, end.character),
      issue.message, vscode.DiagnosticSeverity.Error,
    );
    diagnostic.source = 'Firely';
    return diagnostic;
  });
  diagnostics.set(vscode.Uri.file(file), entries);
}

async function chooseValidationOptions(signal) {
  if (signal.aborted) return undefined;
  const cancellation = new vscode.CancellationTokenSource();
  const cancelSelection = () => cancellation.cancel();
  signal.addEventListener('abort', cancelSelection, { once: true });
  if (signal.aborted) cancellation.cancel();
  try {
    const selection = await vscode.window.showQuickPick(
      [
        { label: 'Run SUSHI', picked: true, description: 'Rebuild fsh-generated before validation' },
        { label: 'Delete output folder', picked: true, description: 'Prevents Firely from using stale publisher output' },
      ],
      {
        canPickMany: true,
        title: 'Validation options',
        placeHolder: 'Choose which preparation steps to run',
      },
      cancellation.token,
    );
    if (selection === undefined) return undefined;
    return {
      runSushi: selection.some((item) => item.label === 'Run SUSHI'),
      deleteOutput: selection.some((item) => item.label === 'Delete output folder'),
    };
  } finally {
    signal.removeEventListener('abort', cancelSelection);
    cancellation.dispose();
  }
}

async function handleResultAction(action) {
  if (action === 'Show Problems') {
    await vscode.commands.executeCommand('workbench.actions.view.problems');
  }
}

async function showSummary(summary) {
  const message = `Firely: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`;
  if (summary.failed > 0) {
    const action = await vscode.window.showErrorMessage(message, 'Show Problems');
    await handleResultAction(action);
  } else if (summary.warnings.length > 0) {
    await vscode.window.showWarningMessage(`${message} ${summary.warnings.join(' ')}`);
  } else {
    await vscode.window.showInformationMessage(message);
  }
}

async function showError(error) {
  if (error.name === 'AbortError') {
    await vscode.window.showInformationMessage('Firely validation cancelled.');
    return;
  }
  await vscode.window.showErrorMessage(error.message);
}

module.exports = {
  prepareOutput, recordResult, chooseValidationOptions, showSummary, showError,
};
