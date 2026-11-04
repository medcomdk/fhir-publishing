const fs = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');
const { runProcess, checkCancelled } = require('./process');

const TEXT = /\.(md|xml|html|xhtml)$/i;
const IMAGE = /\.(svg|png|jpe?g|gif|webp|avif|apng|bmp|ico|tiff?)$/i;
const INTRO = /^(.*)-(intro|notes)\.(md|xml|html|xhtml)$/i;

async function readOptional(file) {
  try { return await fs.readFile(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function narrativeRoots(root) {
  const roots = ['input/pagecontent', 'input/pages', 'input/intro-notes'];
  const config = await readOptional(path.join(root, 'sushi-config.yaml')) ||
    await readOptional(path.join(root, 'sushi-config.yml'));
  if (config) {
    const configured = YAML.parse(config.toString())?.parameters?.['path-pages'];
    for (const entry of configured === undefined ? [] : Array.isArray(configured) ? configured : [configured]) {
      if (typeof entry !== 'string') continue;
      const relative = path.relative(root, path.resolve(root, entry));
      if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) roots.push(relative);
    }
  }
  return [...new Set(roots.map((entry) => path.normalize(entry)))];
}

function contentLocation(file, roots) {
  for (const directory of [...roots, path.join('input', 'includes'), path.join('input', 'images')]) {
    const relative = path.relative(directory, file);
    if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
      if (directory === path.join('input', 'images')) return IMAGE.test(file) ? { kind: 'image', relative } : undefined;
      if (directory === path.join('input', 'includes') && relative === 'menu.xml') return undefined;
      if (TEXT.test(file)) return { kind: directory === path.join('input', 'includes') ? 'include' : 'page', relative };
      if (IMAGE.test(file)) return { kind: 'image', relative, staged: true };
    }
  }
  return undefined;
}

async function writeChanged(file, content, signal) {
  checkCancelled(signal);
  const existing = await readOptional(file);
  if (existing?.equals(content)) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return true;
}

async function refreshNarrative({ root, files, roots, jekyllPath = 'jekyll', signal, log = () => {}, run = runProcess }) {
  const source = path.join(root, 'temp', 'pages');
  const destination = path.join(root, 'temp', 'preview-render');
  const targets = new Set();
  let pages;
  let pagesChanged = false;
  let sharedChanged = false;
  async function pageData() {
    if (pages) return pages;
    const data = await readOptional(path.join(source, '_data', 'pages.json'));
    pages = data ? JSON.parse(data.toString()) : {};
    return pages;
  }

  for (const file of files) {
    checkCancelled(signal);
    const location = contentLocation(file, roots);
    if (!location) continue;
    const content = await readOptional(path.join(root, file));
    if (location.kind === 'image') {
      const output = path.join(root, 'output', location.relative);
      if (content) await writeChanged(output, content, signal);
      else await fs.rm(output, { force: true });
      if (location.staged && await readOptional(path.join(source, '_config.yml'))) {
        if (await writeChanged(path.join(source, '_includes', location.relative), content || Buffer.alloc(0), signal)) sharedChanged = true;
      }
      continue;
    }
    if (!await readOptional(path.join(source, '_config.yml'))) {
      throw Object.assign(new Error('Fast text preview needs temp/pages from a full IG Publisher build. Run a full build once to restore the Jekyll inputs.'), {
        code: 'PUBLISHER_BUILD_REQUIRED',
      });
    }
    const include = path.join(source, '_includes', location.relative);
    const existing = await readOptional(include);
    if (content && existing?.equals(content)) continue;
    const ordinaryPage = location.relative.replace(TEXT, '.html');
    const isPage = location.kind === 'page' && !!await readOptional(path.join(source, ordinaryPage));
    const intro = !isPage && location.kind !== 'include' ? location.relative.match(INTRO) : undefined;
    if (intro) {
      const data = await pageData();
      const field = intro[2].toLowerCase();
      const matching = Object.keys(data).filter((page) => data[page][field] === location.relative.replaceAll(path.sep, '/'));
      const mainPage = `${intro[1]}.html`.replaceAll(path.sep, '/');
      if (data[mainPage] && !matching.includes(mainPage)) matching.push(mainPage);
      for (const page of matching) {
        if (content) {
          data[page][field] = location.relative.replaceAll(path.sep, '/');
          data[page][`${field}-type`] = intro[3].toLowerCase() === 'md' ? 'md' : 'xml';
        } else {
          delete data[page][field];
          delete data[page][`${field}-type`];
        }
        pagesChanged = true;
        targets.add(page);
      }
      if (matching.length === 0) log(`No generated resource page for ${file}. A full Publisher build is needed to add the resource.\n`);
    } else if (location.kind === 'include') {
      sharedChanged = true;
    } else {
      if (isPage) targets.add(ordinaryPage);
      else log(`New page ${file} needs a full Publisher build to create its page and navigation.\n`);
    }
    // A deleted ordinary page stays empty until a full build updates navigation.
    // Deleted intro/notes includes are no longer referenced by the page data.
    await writeChanged(include, content || Buffer.alloc(0), signal);
  }
  if (pagesChanged) await writeChanged(path.join(source, '_data', 'pages.json'), Buffer.from(JSON.stringify(pages)), signal);
  if (sharedChanged) {
    for (const page of Object.keys(await pageData())) {
      if (page.endsWith('.html') && await readOptional(path.join(source, page))) targets.add(page);
    }
  }
  if (targets.size === 0) return;
  // Jekyll does not track changes to site.data during incremental rendering.
  // Touch the affected templates so newly added intro/notes metadata also renders.
  const now = new Date();
  for (const page of targets) {
    checkCancelled(signal);
    await fs.utimes(path.join(source, page), now, now);
  }
  // Render using the cached Publisher templates and generated FHIR fragments.
  // A separate destination keeps Jekyll's cleanup away from QA and other reports.
  const result = await run(jekyllPath, ['build', '--source', source, '--destination', destination, '--incremental'], {
    cwd: root, signal, onOutput: log, processGroup: true,
  });
  checkCancelled(signal);
  if (result.code !== 0) throw new Error(`Jekyll text refresh failed (exit ${result.code}). See the preview output for details.`);
  for (const page of targets) {
    checkCancelled(signal);
    const rendered = await fs.readFile(path.join(destination, page), 'utf8');
    const output = path.join(root, 'output', page);
    const previous = await readOptional(output);
    // Publisher replaces the template's release banner after Jekyll runs.
    const banner = previous?.toString().match(/<!--ReleaseHeader-->[\s\S]*?<!--EndReleaseHeader-->/)?.[0];
    const updated = banner ? rendered.replace(/<!--ReleaseHeader-->[\s\S]*?<!--EndReleaseHeader-->/, () => banner) : rendered;
    await writeChanged(output, Buffer.from(updated), signal);
  }
  log(`Updated text with Jekyll: ${[...targets].join(', ')}\n`);
}

module.exports = { narrativeRoots, contentLocation, refreshNarrative };
