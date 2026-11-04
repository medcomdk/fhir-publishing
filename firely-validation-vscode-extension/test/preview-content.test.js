const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { narrativeRoots, contentLocation, refreshNarrative } = require('../src/preview-content');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fast IG narrative '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pages = path.join(root, 'temp', 'pages');
  const output = path.join(root, 'output');
  async function write(file, text) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
  await write('temp/pages/_config.yml', 'title: Guide');
  await write('temp/pages/_data/pages.json', JSON.stringify({
    'index.html': { title: 'Home' },
    'StructureDefinition-example.html': { title: 'Example', intro: 'StructureDefinition-example-intro.md', 'intro-type': 'md' },
    'nested/background.html': { title: 'Background' },
    'release-notes.html': { title: 'Release Notes' },
  }));
  for (const page of ['index', 'StructureDefinition-example', 'nested/background', 'release-notes']) {
    await write(`temp/pages/${page}.html`, '---\n---\nTemplate with generated FHIR fragments');
    await write(`output/${page}.html`, '<!--ReleaseHeader-->Existing release banner<!--EndReleaseHeader-->Published page');
  }
  await write('output/qa.html', 'Publisher QA report');
  await write('output/package.tgz', 'Publisher package');
  await write('output/StructureDefinition-example.json', 'Published FHIR resource');
  const calls = [];
  const log = [];
  let afterRender;
  async function run(executable, args, options) {
    calls.push({ executable, args, options });
    assert.equal(args[0], 'build', 'text refresh must only invoke Jekyll');
    assert.equal(args[args.indexOf('--source') + 1], pages);
    const destination = args[args.indexOf('--destination') + 1];
    for (const page of ['index', 'StructureDefinition-example', 'nested/background', 'release-notes']) {
      await fs.mkdir(path.dirname(path.join(destination, page)), { recursive: true });
      await fs.writeFile(path.join(destination, `${page}.html`), '<!--ReleaseHeader-->Template banner<!--EndReleaseHeader-->' + page + ' rendered');
    }
    if (afterRender) await afterRender(options.signal);
    return { code: 0 };
  }
  const roots = await narrativeRoots(root);
  async function refresh(files, overrides = {}) {
    return refreshNarrative({ root, roots, files: files.map((file) => path.normalize(file)), run,
      log: (text) => log.push(text), ...overrides });
  }
  return { root, pages, output, roots, write, refresh, calls, log, afterRender: (callback) => { afterRender = callback; } };
}

test('refreshes an existing profile intro with cached templates, preserving reports and generated FHIR', async (t) => {
  const f = await fixture(t);
  const file = 'input/intro-notes/StructureDefinition-example-intro.md';
  await f.write(file, '### Updated intro\nWith **bold** text.');
  await f.refresh([file], { jekyllPath: '/private tools/jekyll' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].executable, '/private tools/jekyll');
  assert.equal(await fs.readFile(path.join(f.pages, '_includes/StructureDefinition-example-intro.md'), 'utf8'), '### Updated intro\nWith **bold** text.');
  const profile = await fs.readFile(path.join(f.output, 'StructureDefinition-example.html'), 'utf8');
  assert.match(profile, /Existing release banner/);
  assert.match(profile, /StructureDefinition-example rendered/);
  assert.match(await fs.readFile(path.join(f.output, 'index.html'), 'utf8'), /Published page/);
  assert.equal(await fs.readFile(path.join(f.output, 'qa.html'), 'utf8'), 'Publisher QA report');
  assert.equal(await fs.readFile(path.join(f.output, 'package.tgz'), 'utf8'), 'Publisher package');
  assert.equal(await fs.readFile(path.join(f.output, 'StructureDefinition-example.json'), 'utf8'), 'Published FHIR resource');
  await f.refresh([file]);
  assert.equal(f.calls.length, 1, 'unchanged text does not render again');
});

test('adds and removes intros and XHTML notes for an existing generated resource', async (t) => {
  const f = await fixture(t);
  const intro = 'input/pagecontent/StructureDefinition-example-intro.md';
  const notes = 'input/pages/StructureDefinition-example-notes.xml';
  await f.write(intro, 'New intro');
  await f.write(notes, '<div xmlns="http://www.w3.org/1999/xhtml"><p>Notes</p></div>');
  await f.refresh([intro, notes]);
  const dataFile = path.join(f.pages, '_data/pages.json');
  let profile = JSON.parse(await fs.readFile(dataFile, 'utf8'))['StructureDefinition-example.html'];
  assert.equal(profile.intro, 'StructureDefinition-example-intro.md');
  assert.equal(profile['intro-type'], 'md');
  assert.equal(profile.notes, 'StructureDefinition-example-notes.xml');
  assert.equal(profile['notes-type'], 'xml');
  await fs.rm(path.join(f.root, intro));
  await fs.rm(path.join(f.root, notes));
  await f.refresh([intro, notes]);
  profile = JSON.parse(await fs.readFile(dataFile, 'utf8'))['StructureDefinition-example.html'];
  assert.equal(profile.intro, undefined);
  assert.equal(profile['intro-type'], undefined);
  assert.equal(profile.notes, undefined);
  assert.equal(profile['notes-type'], undefined);
  assert.equal(f.calls.length, 2);
});

test('supports ordinary and nested pages and shared Markdown includes', async (t) => {
  const f = await fixture(t);
  await f.write('input/pagecontent/index.md', 'Home text');
  await f.write('input/pages/nested/background.md', 'Nested text');
  await f.refresh(['input/pagecontent/index.md', 'input/pages/nested/background.md']);
  assert.equal(await fs.readFile(path.join(f.pages, '_includes/nested/background.md'), 'utf8'), 'Nested text');
  assert.match(await fs.readFile(path.join(f.output, 'index.html'), 'utf8'), /index rendered/);
  assert.match(await fs.readFile(path.join(f.output, 'nested/background.html'), 'utf8'), /nested\/background rendered/);
  assert.match(await fs.readFile(path.join(f.output, 'StructureDefinition-example.html'), 'utf8'), /Published page/);
  await f.write('input/includes/shared.md', 'Shared text');
  await f.refresh(['input/includes/shared.md']);
  assert.match(await fs.readFile(path.join(f.output, 'StructureDefinition-example.html'), 'utf8'), /StructureDefinition-example rendered/);
});

test('copies image bytes and handles deletion without running Jekyll or Publisher', async (t) => {
  const f = await fixture(t);
  const file = 'input/images/nested/logo.PNG';
  await f.write(file, Buffer.from([0, 255, 1]));
  await f.refresh([file]);
  assert.deepEqual(await fs.readFile(path.join(f.output, 'nested/logo.PNG')), Buffer.from([0, 255, 1]));
  await fs.rm(path.join(f.root, file));
  await f.refresh([file]);
  await assert.rejects(fs.access(path.join(f.output, 'nested/logo.PNG')), { code: 'ENOENT' });
  assert.equal(f.calls.length, 0);
});

test('refreshes images used as includes in Markdown text', async (t) => {
  const f = await fixture(t);
  await f.write('input/pagecontent/diagram.svg', '<svg>updated</svg>');
  await f.refresh(['input/pagecontent/diagram.svg']);
  assert.equal(await fs.readFile(path.join(f.pages, '_includes/diagram.svg'), 'utf8'), '<svg>updated</svg>');
  assert.equal(f.calls.length, 1);
});

test('new pages and new resources explain the initial-build requirement without running Publisher', async (t) => {
  const f = await fixture(t);
  await f.write('input/pagecontent/new-page.md', 'New page');
  await f.write('input/intro-notes/StructureDefinition-new-intro.md', 'New resource');
  await f.refresh(['input/pagecontent/new-page.md', 'input/intro-notes/StructureDefinition-new-intro.md']);
  assert.equal(f.calls.length, 0);
  assert.match(f.log.join(''), /New page.*full Publisher build/);
  assert.match(f.log.join(''), /No generated resource page/);
});

test('missing cached Jekyll inputs explain why a one-time Publisher build is needed', async (t) => {
  const f = await fixture(t);
  await f.write('input/pagecontent/index.md', 'Text');
  await fs.rm(path.join(f.pages, '_config.yml'));
  await assert.rejects(f.refresh(['input/pagecontent/index.md']), (error) => {
    assert.equal(error.code, 'PUBLISHER_BUILD_REQUIRED');
    assert.match(error.message, /Run a full build once/);
    return true;
  });
  assert.equal(f.calls.length, 0);
});

test('failed or cancelled Jekyll renders leave the last working page and QA untouched', async (t) => {
  const f = await fixture(t);
  await f.write('input/pagecontent/index.md', 'Text');
  await assert.rejects(f.refresh(['input/pagecontent/index.md'], { run: async () => ({ code: 1 }) }), /Jekyll text refresh failed/);
  assert.match(await fs.readFile(path.join(f.output, 'index.html'), 'utf8'), /Published page/);
  await f.write('input/pagecontent/index.md', 'Text edited again');
  const controller = new AbortController();
  f.afterRender(() => controller.abort());
  await assert.rejects(f.refresh(['input/pagecontent/index.md'], { signal: controller.signal }), { name: 'AbortError' });
  assert.match(await fs.readFile(path.join(f.output, 'index.html'), 'utf8'), /Published page/);
  assert.equal(await fs.readFile(path.join(f.output, 'qa.html'), 'utf8'), 'Publisher QA report');
});

test('honors configured page directories while keeping FHIR and navigation changes in the Publisher pipeline', async (t) => {
  const f = await fixture(t);
  await f.write('sushi-config.yml', 'parameters:\n  path-pages:\n    - input/custom-prose\n');
  const roots = await narrativeRoots(f.root);
  assert.equal(contentLocation(path.normalize('input/custom-prose/intro.md'), roots).kind, 'page');
  for (const file of ['input/fsh/Profile.fsh', 'input/resources/Patient.xml', 'input/includes/menu.xml', 'sushi-config.yml']) {
    assert.equal(contentLocation(path.normalize(file), roots), undefined);
  }
});

test('ordinary pages named notes and shared intro includes are not mistaken for resource fragments', async (t) => {
  const f = await fixture(t);
  await f.write('input/pagecontent/release-notes.md', 'Release text');
  await f.refresh(['input/pagecontent/release-notes.md']);
  assert.match(await fs.readFile(path.join(f.output, 'release-notes.html'), 'utf8'), /release-notes rendered/);
  await f.write('input/includes/shared-intro.md', 'Shared introduction');
  await f.refresh(['input/includes/shared-intro.md']);
  assert.match(await fs.readFile(path.join(f.output, 'StructureDefinition-example.html'), 'utf8'), /StructureDefinition-example rendered/);
  assert.equal(f.log.some((entry) => entry.includes('No generated resource page')), false);
});
