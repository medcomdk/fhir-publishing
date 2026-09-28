const spawn = require('cross-spawn');

const MAX_RETAINED_OUTPUT_CHARACTERS = 1024 * 1024;

function cancelled() {
  const error = new Error('Validation cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkCancelled(signal) {
  if (signal?.aborted) {
    throw cancelled();
  }
}

function terminateWindowsProcessTree(child) {
  const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  killer.on('error', () => child.kill());
}

function terminateProcessTree(child, signal, processGroup) {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    terminateWindowsProcessTree(child);
    return;
  }
  if (!processGroup) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      child.kill(signal);
    }
  }
}

function attachCancellation(child, signal, processGroup) {
  function abort() {
    // Commands are ordinary children by default because detached process
    // groups are terminated in some minimal/sandboxed Linux environments.
    // Callers may still opt into a process group when they control the host.
    terminateProcessTree(child, 'SIGKILL', processGroup);
  }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  return function disposeCancellation() {
    signal?.removeEventListener('abort', abort);
  };
}

// cross-spawn also handles npm's sushi.cmd shim on Windows.
function runProcess(command, args, {
  cwd, signal, onOutput = () => {}, processGroup = false,
} = {}) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      detached: processGroup && process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const disposeCancellation = attachCancellation(child, signal, processGroup);
    let output = '';
    let spawnError;

    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        onOutput(chunk);
        // Stream all output, but bound the text retained for diagnostics.
        output = (output + chunk).slice(-MAX_RETAINED_OUTPUT_CHARACTERS);
      });
    }
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, exitSignal) => {
      disposeCancellation();
      if (signal?.aborted) {
        reject(cancelled());
      } else if (spawnError) {
        reject(new Error(
          `Cannot run ${command}: ${spawnError.message}. ` +
          'Check the executable path and PATH in the VS Code environment.',
          { cause: spawnError },
        ));
      } else if (exitSignal) {
        reject(new Error(`${command} was terminated by ${exitSignal}.`));
      } else {
        resolve({ code, output });
      }
    });
  });
}

module.exports = { runProcess, checkCancelled };
