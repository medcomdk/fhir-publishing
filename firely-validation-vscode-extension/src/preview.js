const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { runProcess, checkCancelled } = require('./process');

const IMAGE_FILE = /\.(svg|png|jpe?g|gif|webp|avif|apng|bmp|ico|tiff?|heic|heif)$/i;
const NARRATIVE_FILE = /\.(md|xml|html|xhtml)$/i;

async function requirePath(file, directory, message, code) {
  try {
    const stat = await fs.stat(file);
    if (directory ? stat.isDirectory() : stat.isFile()) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  throw Object.assign(new Error(message), code ? { code } : {});
}

async function requirePreviewBuild(root) {
  const pages = path.join(root, 'temp', 'pages');
  const message = 'Run a full IG Publisher build first. Live preview needs temp/pages/_config.yml and temp/pages/_includes.';
  await requirePath(path.join(pages, '_config.yml'), false, message, 'PUBLISHER_BUILD_REQUIRED');
  await requirePath(path.join(pages, '_includes'), true, message, 'PUBLISHER_BUILD_REQUIRED');
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

async function syncContent(source, destinationRoot, log, signal, relative = '', imagesOnly = false) {
  checkCancelled(signal);
  const entries = await fs.readdir(path.join(source, relative), { withFileTypes: true }).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      await syncContent(source, destinationRoot, log, signal, file, imagesOnly);
    } else if (entry.isFile() && (IMAGE_FILE.test(entry.name) || (!imagesOnly && NARRATIVE_FILE.test(entry.name)))) {
      checkCancelled(signal);
      const destination = path.join(destinationRoot, file);
      try {
        const content = await fs.readFile(path.join(source, file));
        const existing = await fs.readFile(destination).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        });
        if (existing?.equals(content)) continue;
        checkCancelled(signal);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content);
        if (existing) log(`Updated: ${file}\n`);
        else if (IMAGE_FILE.test(entry.name)) log(`Added image: ${file}\n`);
        else log(`New include: ${file}; new pages need a full Publisher build.\n`);
      } catch (error) {
        // Editors can replace files during a save; retry on the next poll.
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => reject(new Error(
      `Preview port ${port} is unavailable (${error.code}). Stop the other server or change fhirIg.preview.port.`,
    )));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
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
  pollInterval = 500, startupTimeout = 120000,
}) {
  checkCancelled(signal);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('fhirIg.preview.port must be an integer between 1 and 65535.');
  }
  const pages = path.join(root, 'temp', 'pages');
  const includes = path.join(pages, '_includes');
  const source = path.join(root, 'input', 'pagecontent');
  const images = path.join(root, 'input', 'images');
  async function syncFiles(watchSignal) {
    await syncContent(source, includes, log, watchSignal);
    // Publisher copies input/images to the site root, preserving subdirectories.
    // This folder is optional and may be created while preview is running.
    await syncContent(images, pages, log, watchSignal, '', true);
  }
  await requirePreviewBuild(root);
  await requirePath(source, true, 'This guide has no input/pagecontent directory to preview.');
  await checkJekyll({ root, jekyllPath, signal, log, run });
  const reloadPort = port === 65535 ? port - 1 : port + 1;
  await checkPort(port);
  await checkPort(reloadPort);
  checkCancelled(signal);
  await syncFiles(signal);

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const url = `http://127.0.0.1:${port}/`;
  let completion;
  let watching;
  try {
    completion = run(jekyllPath, [
      'serve', '--source', pages, '--destination', path.join(root, 'temp', 'preview'),
      '--host', '127.0.0.1', '--port', String(port), '--baseurl', '',
      '--livereload', '--livereload-port', String(reloadPort),
    ], {
      cwd: root, signal: controller.signal, onOutput: log, processGroup: true,
    }).then((result) => ({ result }), (error) => ({ error }));
    const exited = completion.then(({ result, error }) => {
      throw error || new Error(`Jekyll stopped (exit ${result.code}). See the MedCom IG Preview output for details.`);
    });
    await Promise.race([waitForServer(url, controller.signal, startupTimeout), exited]);
    log(`\nPreview: ${url}\nWatching input/pagecontent and input/images. Save to refresh the preview.\n`);
    log('New/deleted pages, navigation, and FHIR changes need a full Publisher build.\n');
    async function watch() {
      while (true) {
        await delay(pollInterval, undefined, { signal: controller.signal });
        await syncFiles(controller.signal);
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
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = { runPreview, syncContent, requirePreviewBuild, checkJekyll };
