const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { runPreview } = require('../src/preview');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ig preview with spaces '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'input', 'pagecontent');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'index.md'), 'before');
  const pages = path.join(root, 'temp', 'pages');
  await fs.mkdir(path.join(pages, '_includes'), { recursive: true });
  await fs.mkdir(path.join(pages, '_data'), { recursive: true });
  await fs.writeFile(path.join(pages, '_config.yml'), 'title: Preview');
  await fs.writeFile(path.join(pages, '_includes', 'index.md'), 'before');
  await fs.writeFile(path.join(pages, '_data', 'pages.json'), JSON.stringify({ 'index.html': { title: 'Home' } }));
  await fs.writeFile(path.join(pages, 'index.html'), '---\n---\n{% include index.md %}');
  await fs.mkdir(path.join(root, 'output'), { recursive: true });
  await fs.writeFile(path.join(root, 'output', 'index.html'), 'Complete guide');
  await fs.writeFile(path.join(root, 'output', 'qa.html'), 'QA report');
  return { root, source };
}

async function freePort(t) {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => server.close());
  await new Promise((resolve) => server.close(resolve));
  return port;
}

for (const file of ['index.html', 'qa.html']) {
  test(`requires output/${file} even when intermediate Publisher files exist`, async (t) => {
    const { root } = await fixture(t);
    await fs.mkdir(path.join(root, 'temp', 'pages', '_includes'), { recursive: true });
    await fs.writeFile(path.join(root, 'temp', 'pages', '_config.yml'), 'title: Partial build');
    await fs.rm(path.join(root, 'output', file));
    await assert.rejects(runPreview({ root, run() { assert.fail('must check build first'); } }), (error) => {
      assert.equal(error.code, 'PUBLISHER_BUILD_REQUIRED');
      assert.match(error.message, /output\/index.html and output\/qa.html/);
      return true;
    });
  });
}

async function waitUntil(predicate) {
  while (!await predicate()) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function runningPreview(t, project, overrides = {}) {
  const port = await freePort(t);
  const controller = new AbortController();
  const log = [];
  let opened;
  const ready = new Promise((resolve) => { opened = resolve; });
  let closed = false;
  let selectedPort;
  let reloadPort;
  const completion = runPreview({
    root: project.root, port, signal: controller.signal, pollInterval: 10, debounceInterval: 20,
    log: (text) => log.push(text),
    run: async (executable, args, options) => {
      if (args[0] === '--version') return { code: 0 };
      if (args[0] === 'build') {
        const destination = args[args.indexOf('--destination') + 1];
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, 'index.html'), await fs.readFile(path.join(project.root, 'temp', 'pages', '_includes', 'index.md')));
        return { code: 0 };
      }
      assert.equal(args[args.indexOf('--source') + 1], path.join(project.root, 'output'));
      assert.equal(args[args.indexOf('--destination') + 1], path.join(project.root, 'temp', 'preview'));
      assert.ok(args.includes('--livereload'));
      assert.ok(args.includes('--force_polling'), 'Publisher may replace the output directory');
      selectedPort = Number(args[args.indexOf('--port') + 1]);
      reloadPort = Number(args[args.indexOf('--livereload-port') + 1]);
      assert.notEqual(reloadPort, selectedPort);
      assert.equal(options.processGroup, true);
      if (overrides.beforeBind) await overrides.beforeBind();
      const server = http.createServer(async (request, response) => {
        response.end(await fs.readFile(path.join(project.root, 'output', request.url === '/' ? 'index.html' : request.url.slice(1))));
      });
      await new Promise((resolve) => server.listen(selectedPort, '127.0.0.1', resolve));
      return new Promise((resolve) => options.signal.addEventListener('abort', () => server.close(() => {
        closed = true;
        resolve({ code: 0 });
      }), { once: true }));
    },
    onReady: opened,
    requestRebuild: async () => true,
    ...overrides,
  });
  const stopped = assert.rejects(completion, { name: 'AbortError' });
  async function stop() { controller.abort(); await stopped; }
  t.after(stop);
  const url = await ready;
  return { url, log, port: selectedPort, reloadPort, controller, stop, isClosed: () => closed };
}

test('explains missing Jekyll and broken Ruby installations', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(runPreview({ root, run: async () => { throw new Error('ENOENT'); } }), (error) => {
    assert.equal(error.code, 'JEKYLL_UNAVAILABLE');
    assert.match(error.message, /Install Ruby and Jekyll/);
    return true;
  });
  await assert.rejects(runPreview({ root, run: async () => ({ code: 1 }) }), (error) => {
    assert.equal(error.code, 'JEKYLL_UNAVAILABLE');
    assert.match(error.message, /required gems/);
    return true;
  });
});

test('rejects invalid configured ports before launching a server', async (t) => {
  const { root } = await fixture(t);
  for (const port of [0, 65536, 1.5, '4000']) {
    await assert.rejects(runPreview({ root, port }), /integer between 1 and 65535/);
  }
});

// Reserve a consecutive block so port selection assertions do not depend on
// other services running on the test machine.
async function portBlock(t, count) {
  while (true) {
    const servers = [];
    async function closeAll() {
      await Promise.all(servers.filter((server) => server.listening)
        .map((server) => new Promise((resolve) => server.close(resolve))));
    }
    try {
      let port;
      for (let i = 0; i < count; i++) {
        const server = net.createServer();
        servers.push(server);
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(i === 0 ? 0 : port + i, '127.0.0.1', resolve);
        });
        if (i === 0) {
          port = server.address().port;
          if (port + count - 1 > 65535) break;
        }
      }
      if (servers.length === count) {
        t.after(closeAll);
        return { port, servers };
      }
    } catch (error) {
      if (error.code !== 'EADDRINUSE') { await closeAll(); throw error; }
    }
    await closeAll();
  }
}

for (const occupied of [1, 2]) {
  test(`skips ${occupied} occupied HTTP ports and opens the selected URL`, { timeout: 5000 }, async (t) => {
    const project = await fixture(t);
    const { port, servers } = await portBlock(t, occupied + 2);
    for (const server of servers.slice(occupied)) {
      await new Promise((resolve) => server.close(resolve));
    }
    const preview = await runningPreview(t, project, { port });
    assert.equal(preview.port, port + occupied);
    assert.equal(preview.reloadPort, port + occupied + 1);
    assert.equal(preview.url, `http://127.0.0.1:${port + occupied}/`);
    assert.equal(await (await fetch(preview.url)).text(), 'Complete guide');
    assert.ok(preview.log.some((text) => text.includes(`Using port ${port + occupied}`)));
    for (const server of servers.slice(0, occupied)) assert.equal(server.listening, true);
    await preview.stop();
  });
}

test('keeps the preferred HTTP port when only the LiveReload port is occupied', { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  const { port, servers } = await portBlock(t, 3);
  await new Promise((resolve) => servers[0].close(resolve));
  await new Promise((resolve) => servers[2].close(resolve));
  const preview = await runningPreview(t, project, { port });
  assert.equal(preview.port, port);
  assert.equal(preview.reloadPort, port + 2);
  assert.equal(preview.url, `http://127.0.0.1:${port}/`);
  assert.equal(servers[1].listening, true);
  await preview.stop();
});

test('serves the complete output without requiring narrative inputs or intermediate files', { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  await fs.rm(path.join(project.root, 'input'), { recursive: true });
  const preview = await runningPreview(t, project);
  assert.equal(await (await fetch(preview.url)).text(), 'Complete guide');
  assert.equal(await (await fetch(preview.url + 'qa.html')).text(), 'QA report');
  await preview.stop();
  assert.equal(preview.isClosed(), true);
});

test('requests consent with exact FHIR and configuration paths while ignoring generated files', { timeout: 10000 }, async (t) => {
  const project = await fixture(t);
  const { root, source } = project;
  let builds = 0;
  const prompts = [];
  const preview = await runningPreview(t, project, {
    requestRebuild: async (files) => { prompts.push(files); return true; },
    rebuild: async () => {
      builds++;
      for (const directory of ['output', 'temp/pages', 'fsh-generated/resources', 'input-cache']) {
        await fs.mkdir(path.join(root, directory), { recursive: true });
        await fs.writeFile(path.join(root, directory, 'generated.json'), String(builds));
      }
    },
  });
  for (const [file, content] of [
    ['input/fsh/profile.fsh', 'Profile: Example'],
    ['input/resources/example.json', '{}'], ['input/includes/menu.xml', '<menu/>'],
    ['sushi-config.yaml', 'id: example'], ['sushi-config.yml', 'id: another'],
    ['ig.ini', '[IG]'], ['package-list.json', '{}'],
  ]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    const previous = builds;
    await fs.writeFile(path.join(root, file), content);
    await waitUntil(() => builds === previous + 1);
    assert.deepEqual(prompts.at(-1), [path.normalize(file)]);
  }
  const previous = builds;
  await fs.rm(path.join(root, 'input', 'fsh', 'profile.fsh'));
  await waitUntil(() => builds === previous + 1);
  assert.deepEqual(prompts.at(-1), [path.join('input', 'fsh', 'profile.fsh')]);
  await fs.writeFile(path.join(root, 'sushi-config.yaml'), 'id: example');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(builds, previous + 1, 'identical saves and generated output must not rebuild');
  await preview.stop();
});

test('waits for affirmative consent before rebuilding a batch of changed files', { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  let builds = 0;
  let choose;
  const prompts = [];
  const preview = await runningPreview(t, project, {
    debounceInterval: 100,
    requestRebuild: (files, signal) => {
      prompts.push(files);
      return new Promise((resolve) => {
        choose = resolve;
        signal.addEventListener('abort', () => resolve(false), { once: true });
      });
    },
    rebuild: async () => { builds++; },
  });
  await fs.mkdir(path.join(project.root, 'input', 'fsh'), { recursive: true });
  await fs.writeFile(path.join(project.root, 'input', 'fsh', 'profile.fsh'), 'Profile: Example');
  await fs.writeFile(path.join(project.root, 'sushi-config.yaml'), 'id: example');
  await waitUntil(() => prompts.length === 1);
  assert.deepEqual(prompts[0], [path.join('input', 'fsh', 'profile.fsh'), 'sushi-config.yaml']);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(builds, 0);
  choose(true);
  await waitUntil(() => builds === 1);
  await preview.stop();
});

test('postpones declined rebuilds without repeat prompts and remembers files for the next request', { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  let builds = 0;
  const prompts = [];
  const preview = await runningPreview(t, project, {
    requestRebuild: async (files) => { prompts.push(files); return prompts.length > 1; },
    rebuild: async () => { builds++; },
  });
  await fs.writeFile(path.join(project.root, 'sushi-config.yaml'), 'id: example');
  await waitUntil(() => prompts.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(builds, 0);
  assert.equal(prompts.length, 1);
  await fs.writeFile(path.join(project.source, 'index.md'), 'Text still refreshes');
  await waitUntil(async () => (await fs.readFile(path.join(project.root, 'output', 'index.html'), 'utf8')) === 'Text still refreshes');
  assert.equal(prompts.length, 1);
  await fs.writeFile(path.join(project.root, 'ig.ini'), '[IG]');
  await waitUntil(() => builds === 1);
  assert.deepEqual(prompts[1], ['ig.ini', 'sushi-config.yaml']);
  await fs.writeFile(path.join(project.root, 'ig.ini'), '[IG]\nig = changed');
  await waitUntil(() => builds === 2);
  assert.deepEqual(prompts[2], ['ig.ini']);
  await preview.stop();
});

test('detects nested FSH edits and refreshes text while a rebuild choice is still pending', { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  const profile = path.join('input', 'fsh', 'profiles', 'Example.fsh');
  await fs.mkdir(path.dirname(path.join(project.root, profile)), { recursive: true });
  await fs.writeFile(path.join(project.root, profile), 'Profile: Before');
  const prompts = [];
  let builds = 0;
  let choose;
  const preview = await runningPreview(t, project, {
    requestRebuild: (files) => {
      prompts.push(files);
      return new Promise((resolve) => { choose = resolve; });
    },
    rebuild: async () => { builds++; },
  });
  await fs.writeFile(path.join(project.root, 'sushi-config.yaml'), 'id: example');
  await waitUntil(() => prompts.length === 1);
  await fs.writeFile(path.join(project.root, profile), 'Profile: After');
  await waitUntil(() => preview.log.some((line) => line.includes('requires confirmation') && line.includes(profile)));
  assert.equal(builds, 0);
  assert.equal(prompts.length, 1, 'keep one request open while continuing to monitor files');
  await fs.writeFile(path.join(project.source, 'index.md'), 'Text refresh while waiting');
  await waitUntil(async () => (await fs.readFile(path.join(project.root, 'output', 'index.html'), 'utf8')) === 'Text refresh while waiting');
  choose(false);
  await waitUntil(() => prompts.length === 2);
  assert.deepEqual(prompts[1], [profile, 'sushi-config.yaml']);
  choose(true);
  await waitUntil(() => builds === 1);
  await preview.stop();
});

test('FSH edits, renames and deletions each request a rebuild after dismissing the previous prompt', { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  const profile = path.join('input', 'fsh', 'profiles', 'Example.fsh');
  const renamed = path.join('input', 'fsh', 'profiles', 'Renamed.fsh');
  await fs.mkdir(path.dirname(path.join(project.root, profile)), { recursive: true });
  await fs.writeFile(path.join(project.root, profile), 'Profile: Before');
  const prompts = [];
  const preview = await runningPreview(t, project, {
    requestRebuild: async (files) => { prompts.push(files); return false; },
    rebuild: async () => assert.fail('FSH changes must never rebuild without consent'),
  });
  await fs.writeFile(path.join(project.root, profile), 'Profile: After');
  await waitUntil(() => prompts.length === 1);
  assert.deepEqual(prompts[0], [profile]);
  await fs.rename(path.join(project.root, profile), path.join(project.root, renamed));
  await waitUntil(() => prompts.length === 2);
  assert.deepEqual(prompts[1], [profile, renamed]);
  await fs.rm(path.join(project.root, renamed));
  await waitUntil(() => prompts.length === 3);
  assert.deepEqual(prompts[2], [profile, renamed]);
  await preview.stop();
});

test('never rebuilds without a confirmation handler', { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  const preview = await runningPreview(t, project, {
    requestRebuild: undefined,
    rebuild: async () => assert.fail('no consent was given'),
  });
  await fs.writeFile(path.join(project.root, 'sushi-config.yaml'), 'id: example');
  await waitUntil(() => preview.log.some((text) => text.includes('rebuild postponed')));
  assert.equal(preview.isClosed(), false);
  await preview.stop();
});

test('debounces saves, serializes builds and queues edits saved during a build', { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  let builds = 0;
  let finishBuild;
  let concurrent = 0;
  const preview = await runningPreview(t, project, {
    rebuild: async () => {
      assert.equal(++concurrent, 1);
      if (++builds === 1) await new Promise((resolve) => { finishBuild = resolve; });
      concurrent--;
    },
  });
  const file = path.join(project.root, 'sushi-config.yaml');
  await fs.writeFile(file, 'one');
  await fs.writeFile(file, 'two');
  await fs.writeFile(file, 'three');
  await waitUntil(() => builds === 1);
  await fs.writeFile(file, 'saved during build');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(builds, 1);
  finishBuild();
  await waitUntil(() => builds === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(builds, 2);
  await preview.stop();
});

test('logs a failed rebuild and retries on the next edit without stopping the server', { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  let builds = 0;
  const preview = await runningPreview(t, project, {
    rebuild: async () => { if (++builds === 1) throw new Error('Publisher failed'); },
  });
  await fs.writeFile(path.join(project.root, 'sushi-config.yaml'), 'first');
  await waitUntil(() => preview.log.some((text) => text.includes('Publisher rebuild failed: Publisher failed')));
  await fs.writeFile(path.join(project.root, 'sushi-config.yaml'), 'fixed');
  await waitUntil(() => preview.log.includes('Publisher rebuild complete. Refreshing live preview.\n'));
  assert.equal(builds, 2);
  assert.equal(preview.isClosed(), false);
  await preview.stop();
});

test('Stop cancels a confirmed Publisher build and awaits cleanup', { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  let buildSignal;
  let finishCleanup;
  const cleanup = new Promise((resolve) => { finishCleanup = resolve; });
  const preview = await runningPreview(t, project, {
    rebuild: async (signal) => {
      buildSignal = signal;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await cleanup;
    },
  });
  await fs.writeFile(path.join(project.root, 'sushi-config.yaml'), 'changed');
  await waitUntil(() => buildSignal);
  let stopped = false;
  const stopping = preview.stop().then(() => { stopped = true; });
  assert.equal(buildSignal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stopped, false);
  finishCleanup();
  await stopping;
  assert.equal(preview.isClosed(), true);
});

test('reports a Jekyll startup failure without opening the preview', { timeout: 5000 }, async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(runPreview({
    root, port: await freePort(t),
    run: async (_, args) => ({ code: args[0] === '--version' ? 0 : 7 }),
    onReady: () => assert.fail('must not open a failed server'),
  }), /Jekyll stopped \(exit 7\)/);
});

test('cancellation interrupts server startup and terminates the process', { timeout: 5000 }, async (t) => {
  const { root } = await fixture(t);
  const controller = new AbortController();
  let stopped = false;
  await assert.rejects(runPreview({
    root, port: await freePort(t), signal: controller.signal,
    run: async (_, args, options) => {
      if (args[0] === '--version') return { code: 0 };
      return new Promise((resolve) => {
        options.signal.addEventListener('abort', () => {
          stopped = true;
          resolve({ code: 0 });
        }, { once: true });
        queueMicrotask(() => controller.abort());
      });
    },
    onReady: () => assert.fail('must not open a cancelled preview'),
  }), { name: 'AbortError' });
  assert.equal(stopped, true);
});

test('stopping does not wait for a pending browser opening operation', { timeout: 5000 }, async (t) => {
  const { root } = await fixture(t);
  const port = await freePort(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  let stopped = false;
  await assert.rejects(runPreview({
    root, port, signal: controller.signal,
    run: async (_, args, options) => {
      if (args[0] === '--version') return { code: 0 };
      const server = http.createServer((request, response) => response.end('ready'));
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return new Promise((resolve) => options.signal.addEventListener('abort', () => server.close(() => {
        stopped = true;
        resolve({ code: 0 });
      }), { once: true }));
    },
    onReady: () => {
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    },
  }), { name: 'AbortError' });
  assert.equal(stopped, true);
});

test('simultaneous IG startups reserve different HTTP and LiveReload ports before binding', { timeout: 5000 }, async (t) => {
  const firstProject = await fixture(t);
  const secondProject = await fixture(t);
  const { port, servers } = await portBlock(t, 4);
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  let starting = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const beforeBind = async () => { if (++starting === 2) release(); await gate; };
  const [first, second] = await Promise.all([
    runningPreview(t, firstProject, { port, beforeBind }),
    runningPreview(t, secondProject, { port, beforeBind }),
  ]);
  assert.equal(new Set([first.port, first.reloadPort, second.port, second.reloadPort]).size, 4);
  assert.equal(await (await fetch(first.url)).text(), 'Complete guide');
  assert.equal(await (await fetch(second.url)).text(), 'Complete guide');
  await first.stop();
  assert.equal(await (await fetch(second.url)).text(), 'Complete guide');
  await second.stop();
  const restarted = await runningPreview(t, firstProject, { port });
  assert.equal(restarted.port, port, 'stopping releases reservations for subsequent previews');
  assert.equal(restarted.reloadPort, port + 1);
  await restarted.stop();
});

test('page text and image saves refresh output without calling Publisher and preserve QA', { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  let publisherBuilds = 0;
  const refreshing = [];
  const preview = await runningPreview(t, project, {
    rebuild: async () => { publisherBuilds++; },
    onRefresh: (active) => refreshing.push(active),
  });
  await fs.writeFile(path.join(project.source, 'index.md'), 'Updated text');
  await waitUntil(async () => (await fs.readFile(path.join(project.root, 'output', 'index.html'), 'utf8')) === 'Updated text');
  await fs.mkdir(path.join(project.root, 'input', 'images'), { recursive: true });
  await fs.writeFile(path.join(project.root, 'input', 'images', 'logo.png'), Buffer.from([0, 1, 255]));
  await waitUntil(async () => fs.access(path.join(project.root, 'output', 'logo.png')).then(() => true, () => false));
  assert.equal(publisherBuilds, 0);
  assert.equal(await fs.readFile(path.join(project.root, 'output', 'qa.html'), 'utf8'), 'QA report');
  assert.deepEqual(await fs.readFile(path.join(project.root, 'output', 'logo.png')), Buffer.from([0, 1, 255]));
  assert.ok(refreshing.includes(true));
  assert.equal(await (await fetch(preview.url)).text(), 'Updated text');
  await preview.stop();
});
