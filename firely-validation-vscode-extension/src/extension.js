const vscode = require('vscode');
const path = require('node:path');
const { validateIg } = require('./workflow');
const { checkCancelled } = require('./process');
const { chooseConfig, readSettings } = require('./project');
const {
  configureDotnetEnvironment, configureToolEnvironment, runToolSetup,
} = require('./setup');
const {
  prepareOutput, recordResult, chooseValidationOptions, showSummary, showError,
} = require('./validation-ui');

let activeRun;
let shuttingDown = false;

async function validateWithProgress(configUri, options, controller, ui) {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'MedCom Firely Validation',
    cancellable: true,
  }, async (progress, token) => {
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
      checkCancelled(controller.signal);
      progress.report({ message: 'Checking validation tools' });
      try {
        await runToolSetup(
          ui.setupScript, path.dirname(configUri.fsPath), controller.signal,
        );
      } finally {
        ui.output.show(true);
      }
      configureDotnetEnvironment(ui.environmentVariableCollection);
      checkCancelled(controller.signal);
      return await validateIg({
        configPath: configUri.fsPath,
        ...options,
        ...readSettings(configUri),
        signal: controller.signal,
        log: (text) => ui.output.append(text),
        progress: (message) => progress.report({ message }),
        onResult: (result) => recordResult(ui.diagnostics, result),
      });
    } finally {
      subscription.dispose();
    }
  });
}

async function executeValidation(uri, controller, ui) {
  const configUri = await chooseConfig(uri, controller.signal);
  checkCancelled(controller.signal);
  if (!configUri) return undefined;
  if (configUri.scheme !== 'file') {
    throw new Error('Validation requires a local, WSL, SSH, or container filesystem workspace.');
  }
  const options = await chooseValidationOptions(controller.signal);
  checkCancelled(controller.signal);
  if (options === undefined) return undefined;
  if (!await vscode.workspace.saveAll(false)) {
    throw new Error('Save the implementation guide files before validating.');
  }
  checkCancelled(controller.signal);
  prepareOutput(configUri, ui.output, ui.diagnostics);
  return validateWithProgress(configUri, options, controller, ui);
}

async function startValidation(uri, ui) {
  if (shuttingDown) return;
  if (!vscode.workspace.isTrusted) {
    await vscode.window.showErrorMessage('Trust this workspace before running SUSHI and Firely Terminal.');
    return;
  }
  if (activeRun) {
    await vscode.window.showWarningMessage('A Firely validation is already running. Wait for it or cancel it first.');
    return;
  }

  const controller = new AbortController();
  const completion = executeValidation(uri, controller, ui).then(
    (summary) => ({ summary }),
    (error) => ({ error }),
  );
  activeRun = { controller, completion };
  const outcome = await completion;
  activeRun = undefined;

  if (outcome.error) ui.output.appendLine(`\n${outcome.error.message}`);
  if (shuttingDown) return;
  if (outcome.error) {
    await showError(outcome.error);
  } else if (outcome.summary) {
    await showSummary(outcome.summary);
  }
}

function activate(context) {
  shuttingDown = false;
  configureToolEnvironment(context.environmentVariableCollection);
  const ui = {
    output: vscode.window.createOutputChannel('MedCom Firely Validation'),
    diagnostics: vscode.languages.createDiagnosticCollection('firely'),
    setupScript: context.asAbsolutePath('install-tools.sh'),
    environmentVariableCollection: context.environmentVariableCollection,
  };
  context.subscriptions.push(
    ui.output,
    ui.diagnostics,
    vscode.commands.registerCommand('fhirIg.validate', (uri) => startValidation(uri, ui)),
  );
}

async function deactivate() {
  shuttingDown = true;
  if (activeRun) {
    activeRun.controller.abort();
    await activeRun.completion;
  }
}

module.exports = { activate, deactivate };
