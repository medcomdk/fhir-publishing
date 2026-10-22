const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { runPreview, syncContent } = require('../src/preview');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ig preview with spaces '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'input', 'pagecontent');
  const includes = path.join(root, 'temp', 'pages', '_includes');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(includes, { recursive: true });
  await fs.writeFile(path.join(root, 'temp', 'pages', '_config.yml'), 'title: Preview\n');
  return { root, source, includes };
}

async function freePort(t) {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => server.close());
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('syncs narrative files recursively, skips hidden files and symlinks, and preserves generated includes', async (t) => {
  const { source, includes } = await fixture(t);
  const files = {
    'index.md': 'Updated narrative', 'nested/a.xml': '<p>xml</p>',
    'a.html': '<p>html</p>', 'a.xhtml': '<p>xhtml</p>',
    '.hidden.md': 'hidden', '.hidden/a.md': 'hidden', 'ignored.json': '{}',
  };
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(path.join(source, file), content);
  }
  await fs.writeFile(path.join(includes, 'publisher.md'), 'Generated content');
  if (process.platform !== 'win32') await fs.symlink(path.join(source, 'index.md'), path.join(source, 'link.md'));
  const log = [];
  await syncContent(source, includes, (text) => log.push(text));
  for (const file of ['index.md', 'nested/a.xml', 'a.html', 'a.xhtml']) {
    assert.equal(await fs.readFile(path.join(includes, file), 'utf8'), files[file]);
  }
  for (const file of ['.hidden.md', '.hidden/a.md', 'ignored.json', 'link.md']) {
    await assert.rejects(fs.access(path.join(includes, file)), { code: 'ENOENT' });
  }
  assert.equal(log.length, 4);
  await syncContent(source, includes, (text) => log.push(text));
  assert.equal(log.length, 4, 'unchanged files must not trigger a rebuild');
  await fs.rm(path.join(source, 'index.md'));
  await syncContent(source, includes, () => {});
  assert.equal(await fs.readFile(path.join(includes, 'publisher.md'), 'utf8'), 'Generated content');
  assert.equal(await fs.readFile(path.join(includes, 'index.md'), 'utf8'), files['index.md']);
});

test('syncs images in pagecontent byte-for-byte, including nested paths and uppercase extensions', async (t) => {
  const { source, includes } = await fixture(t);
  const binary = Buffer.from([0, 255, 137, 80, 13, 10, 26, 10]);
  const files = ['inline.svg', 'nested/logo.PNG', 'photo.jpg', 'photo.JPEG', 'animation.gif',
    'image.webp', 'image.avif', 'image.apng', 'image.bmp', 'icon.ico', 'image.tiff'];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(path.join(source, file), binary);
  }
  const log = [];
  await syncContent(source, includes, (text) => log.push(text));
  for (const file of files) {
    assert.deepEqual(await fs.readFile(path.join(includes, file)), binary);
  }
  assert.ok(log.every((text) => text.startsWith('Added image: ')));
  log.length = 0;
  await syncContent(source, includes, (text) => log.push(text));
  assert.equal(log.length, 0, 'unchanged images do not trigger regeneration');
});

test('copies input/images into the site root, ignores non-images, and tolerates a missing image folder', async (t) => {
  const { root } = await fixture(t);
  const source = path.join(root, 'input', 'images');
  const pages = path.join(root, 'temp', 'pages');
  await syncContent(source, pages, () => {}, undefined, '', true);
  await fs.mkdir(path.join(source, 'diagrams'), { recursive: true });
  await fs.writeFile(path.join(source, 'diagrams', 'example.svg'), '<svg/>');
  await fs.writeFile(path.join(source, 'notes.md'), 'This is not an image');
  await fs.writeFile(path.join(source, '.private.png'), 'hidden');
  await syncContent(source, pages, () => {}, undefined, '', true);
  assert.equal(await fs.readFile(path.join(pages, 'diagrams', 'example.svg'), 'utf8'), '<svg/>');
  for (const file of ['notes.md', '.private.png']) {
    await assert.rejects(fs.access(path.join(pages, file)), { code: 'ENOENT' });
  }
});

test('explains missing Publisher output before trying Jekyll', async (t) => {
  const { root } = await fixture(t);
  await fs.rm(path.join(root, 'temp', 'pages', '_config.yml'));
  await assert.rejects(runPreview({ root, run() { assert.fail('must check build first'); } }), (error) => {
    assert.equal(error.code, 'PUBLISHER_BUILD_REQUIRED');
    assert.match(error.message, /full IG Publisher build/);
    return true;
  });
});

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

test('rejects invalid and occupied ports before launching a server', async (t) => {
  const { root } = await fixture(t);
  for (const port of [0, 65536, 1.5, '4000']) {
    await assert.rejects(runPreview({ root, port }), /integer between 1 and 65535/);
  }
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(runPreview({
    root, port: server.address().port,
    run: async (_, args) => {
      assert.deepEqual(args, ['--version']);
      return { code: 0 };
    },
  }), /port .* unavailable/);
});

test('waits for readiness, watches saved content, and waits for server cleanup on stop', { timeout: 10000 }, async (t) => {
  const { root, source, includes } = await fixture(t);
  await fs.writeFile(path.join(source, 'index.md'), 'before');
  const images = path.join(root, 'input', 'images', 'nested');
  const imageBefore = Buffer.from([0, 255, 1]);
  const imageAfter = Buffer.from([0, 255, 2]);
  await fs.mkdir(images, { recursive: true });
  await fs.writeFile(path.join(images, 'logo.PNG'), imageBefore);
  const port = await freePort(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  let closed = false;
  let ready = false;
  const run = async (executable, args, options) => {
    assert.equal(executable, 'custom-jekyll');
    if (args[0] === '--version') return { code: 0 };
    assert.equal(args[args.indexOf('--destination') + 1], path.join(root, 'temp', 'preview'));
    assert.equal(args[args.indexOf('--livereload-port') + 1], String(port + 1));
    assert.equal(options.processGroup, true);
    assert.equal(await fs.readFile(path.join(includes, 'index.md'), 'utf8'), 'before');
    assert.deepEqual(await fs.readFile(path.join(root, 'temp', 'pages', 'nested', 'logo.PNG')), imageBefore);
    const server = http.createServer((request, response) => response.end('ready'));
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    return new Promise((resolve) => {
      options.signal.addEventListener('abort', () => server.close(() => {
        closed = true;
        resolve({ code: 0 });
      }), { once: true });
    });
  };
  const completion = runPreview({
    root, port, jekyllPath: 'custom-jekyll', signal: controller.signal, run, pollInterval: 10,
    onReady: async (url) => {
      ready = true;
      assert.equal(url, `http://127.0.0.1:${port}/`);
      await fs.writeFile(path.join(source, 'index.md'), 'after');
      await fs.writeFile(path.join(images, 'logo.PNG'), imageAfter);
    },
    log: (text) => { if (ready && text === 'Updated: nested/logo.PNG\n'.replaceAll('/', path.sep)) controller.abort(); },
  });
  await assert.rejects(completion, { name: 'AbortError' });
  assert.equal(await fs.readFile(path.join(includes, 'index.md'), 'utf8'), 'after');
  assert.deepEqual(await fs.readFile(path.join(root, 'temp', 'pages', 'nested', 'logo.PNG')), imageAfter);
  assert.equal(closed, true);
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
