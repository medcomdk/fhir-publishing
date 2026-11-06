const { runProcess, checkCancelled } = require('./process');

function createCommandRunner({ cwd, signal, log, run = runProcess }) {
  async function runCommand(executable, args, {
    streamOutput = true, processGroup = false,
  } = {}) {
    checkCancelled(signal);
    const displayArgs = args.map((arg) => JSON.stringify(arg)).join(' ');
    log(`\n> ${executable} ${displayArgs}\n`);
    return run(executable, args, {
      cwd,
      signal,
      onOutput: streamOutput ? log : undefined,
      processGroup,
    });
  }

  async function runRequiredCommand(executable, args, options) {
    const result = await runCommand(executable, args, options);
    if (result.code !== 0) {
      throw new Error(`${executable} ${args[0]} failed (exit ${result.code}). See Firely output for details.`);
    }
    return result;
  }

  return { runCommand, runRequiredCommand };
}

module.exports = { createCommandRunner };
