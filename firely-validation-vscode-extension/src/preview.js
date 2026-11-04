const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { runProcess, checkCancelled } = require('./process');
const { narrativeRoots, contentLocation, refreshNarrative } = require('./preview-content');

// Keep starting sessions from selecting the same ports before Jekyll binds.
const reservedPorts = new Set();

async function requireFile(file, message, code) {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  throw Object.assign(new Error(message), code ? { code } : {});
}

async function requirePreviewBuild(root) {
  const message = 'Run a full IG Publisher build first. Live preview needs output/index.html and output/qa.html.';
  for (const file of ['index.html', 'qa.html']) {
    await requireFile(path.join(root, 'output', file), message, 'PUBLISHER_BUILD_REQUIRED');
  }
}

async function checkJekyll({ root, jekyllPath = 'jekyll', signal, log = () => {}, run = runProcess }) {
  checkCancelled(signal);
  let version;
  try {
    version = await run(jekyllPath, ['--version'], { cwd: root, signal, onOutput: log });
  } catch (error) {
    checkCancelled(signal);
    throw Object.assign(new Error(
      'Cannot run Jekyll. Install Ruby and Jekyll in the environment used for your IG build, ' +
      'then restart VS Code, or set fhirIg.preview.jekyllPath to its executable. ' + error.message,
    ), { code: 'JEKYLL_UNAVAILABLE' });
  }
  if (version.code !== 0) {
    throw Object.assign(new Error('Jekyll is installed but could not start. Check Ruby, Jekyll and the required gems in the MedCom IG Preview output.'), {
      code: 'JEKYLL_UNAVAILABLE',
    });
  }
}

// Watch authored inputs only: Publisher and Jekyll write to output, temp,
// fsh-generated and caches. Watching those would cause rebuild loops.
function createSourceSnapshot(root, roots) {
  let cache = new Map();
  return async (signal) => {
    const next = new Map();
    async function visit(relative) {
      checkCancelled(signal);
      const file = path.join(root, relative);
      try {
        const stat = await fs.lstat(file);
        if (stat.isDirectory()) {
          const entries = await fs.readdir(file);
          for (const entry of entries.sort()) {
            if (!entry.startsWith('.')) await visit(path.join(relative, entry));
          }
        } else if (stat.isFile()) {
          const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
          const previous = cache.get(relative);
          const digest = previous?.stamp === stamp ? previous.digest
            : createHash('sha256').update(await fs.readFile(file)).digest('hex');
          next.set(relative, { stamp, digest });
        }
      } catch (error) {
        // Optional inputs and files replaced during a save are checked again.
        if (error.code !== 'ENOENT') throw error;
      }
    }
    for (const source of new Set(['input', ...roots, 'sushi-config.yaml', 'sushi-config.yml', 'ig.ini', 'package-list.json'])) {
      await visit(source);
    }
    cache = next;
    const files = new Map([...next].map(([file, { digest }]) => [file, digest]));
    return { files, signature: JSON.stringify([...files]) };
  };
}

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => reject(Object.assign(new Error(
      `Preview port ${port} is unavailable (${error.code}).`,
    ), { code: error.code })));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

async function findAvailablePort(start, signal, excludedPort) {
  for (let port = start; port <= 65535; port++) {
    checkCancelled(signal);
    if (port === excludedPort || reservedPorts.has(port)) continue;
    try {
      await checkPort(port);
      if (reservedPorts.has(port)) continue;
      reservedPorts.add(port);
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    }
  }
  throw Object.assign(new Error(`No available preview port from ${start} to 65535.`), {
    code: 'NO_PREVIEW_PORT_AVAILABLE',
  });
}

async function reservePreviewPorts(preferredPort, signal) {
  const port = await findAvailablePort(preferredPort, signal);
  try {
    let reloadPort;
    try {
      reloadPort = await findAvailablePort(port + 1, signal);
    } catch (error) {
      if (error.code !== 'NO_PREVIEW_PORT_AVAILABLE') throw error;
      reloadPort = await findAvailablePort(1, signal, port);
    }
    return { port, reloadPort };
  } catch (error) {
    reservedPorts.delete(port);
    throw error;
  }
}

function responds(url, signal) {
  return new Promise((resolve) => {
    const request = http.get(url, { signal, timeout: 1000 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 400);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitForServer(url, signal, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    checkCancelled(signal);
    if (await responds(url, signal)) return;
    await delay(250, undefined, { signal });
  }
  throw new Error('Jekyll did not become ready within two minutes. See the MedCom IG Preview output for details.');
}

async function runPreview({
  root, port = 4000, jekyllPath = 'jekyll', signal,
  log = () => {}, onReady = async () => {}, run = runProcess,
  rebuild, onRefresh = () => {}, pollInterval = 500, debounceInterval = 500, startupTimeout = 120000,
}) {
  checkCancelled(signal);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('fhirIg.preview.port must be an integer between 1 and 65535.');
  }
  const source = path.join(root, 'output');
  await requirePreviewBuild(root);
  const roots = await narrativeRoots(root);
  const snapshot = createSourceSnapshot(root, roots);
  let builtSources = await snapshot(signal);
  await checkJekyll({ root, jekyllPath, signal, log, run });
  await refreshNarrative({ root, roots, files: [...builtSources.files.keys()], jekyllPath, signal, log, run });
  const preferredPort = port;
  const ports = await reservePreviewPorts(preferredPort, signal);
  port = ports.port;
  const { reloadPort } = ports;

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const url = `http://127.0.0.1:${port}/`;
  let completion;
  let watching;
  try {
    checkCancelled(signal);
    if (port !== preferredPort) log(`Preview port ${preferredPort} is unavailable. Using port ${port}.\n`);
    // Publisher can replace output entirely. Polling keeps Jekyll watching the
    // path after replacement instead of retaining a watch on the old directory.
    completion = run(jekyllPath, [
      'serve', '--source', source, '--destination', path.join(root, 'temp', 'preview'),
      '--host', '127.0.0.1', '--port', String(port), '--baseurl', '',
      '--livereload', '--livereload-port', String(reloadPort), '--force_polling',
    ], {
      cwd: root, signal: controller.signal, onOutput: log, processGroup: true,
    }).then((result) => ({ result }), (error) => ({ error }));
    const exited = completion.then(({ result, error }) => {
      throw error || new Error(`Jekyll stopped (exit ${result.code}). See the MedCom IG Preview output for details.`);
    });
    await Promise.race([waitForServer(url, controller.signal, startupTimeout), exited]);
    log(`\nPreview: ${url}\nWatching narrative pages, resource intros/notes, includes and images for fast refresh. FHIR and configuration changes use Publisher.\n`);
    async function watch() {
      let pending;
      let changedAt;
      while (true) {
        await delay(pollInterval, undefined, { signal: controller.signal });
        const current = await snapshot(controller.signal);
        if (current.signature === builtSources.signature) {
          pending = undefined;
          continue;
        }
        if (current.signature !== pending) {
          pending = current.signature;
          changedAt = Date.now();
        }
        if (Date.now() - changedAt < debounceInterval) continue;
        const changed = [...new Set([...builtSources.files.keys(), ...current.files.keys()])]
          .filter((file) => builtSources.files.get(file) !== current.files.get(file));
        // Serialize refreshes, keeping the pre-render snapshot so saves made
        // while Jekyll or Publisher runs are picked up on the next poll.
        builtSources = current;
        pending = undefined;
        const textOnly = changed.every((file) => contentLocation(file, roots));
        log(textOnly ? '\nRefreshing text and images without IG Publisher...\n'
          : '\nFHIR or configuration files changed. Rebuilding with IG Publisher...\n');
        try {
          if (textOnly) {
            onRefresh(true);
            await refreshNarrative({ root, roots, files: changed, jekyllPath, signal: controller.signal, log, run });
          } else {
            await rebuild(controller.signal);
            checkCancelled(controller.signal);
            await requirePreviewBuild(root);
            log('Publisher rebuild complete. Refreshing live preview.\n');
          }
        } catch (error) {
          checkCancelled(controller.signal);
          log(`${textOnly ? 'Text refresh' : 'Publisher rebuild'} failed: ${error.message}\nEdit a source file to retry.\n`);
        } finally {
          if (textOnly && !controller.signal.aborted) onRefresh(false);
        }
      }
    }
    watching = watch();
    await Promise.race([Promise.resolve().then(() => onReady(url)), watching, exited]);
    await Promise.race([watching, exited]);
  } catch (error) {
    checkCancelled(signal);
    throw error;
  } finally {
    controller.abort();
    await Promise.allSettled([completion, watching]);
    reservedPorts.delete(port);
    reservedPorts.delete(reloadPort);
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = { runPreview, requirePreviewBuild, checkJekyll };
