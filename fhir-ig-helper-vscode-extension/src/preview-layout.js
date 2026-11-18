const fs = require('node:fs/promises');
const path = require('node:path');

async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

async function previewPagePrefix(root) {
  let language;
  try {
    const data = await fs.readFile(path.join(root, 'temp', 'pages', '_data', 'languages.json'), 'utf8');
    language = JSON.parse(data).defLang;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // fhir2.base.template keeps redirect pages at the root and the actual pages
  // and narrative includes under the default language (normally en).
  for (const candidate of new Set([language, 'en'])) {
    if (typeof candidate !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(candidate)) continue;
    if (await isFile(path.join(root, 'output', candidate, 'index.html')) ||
        await isFile(path.join(root, 'temp', 'pages', candidate, 'index.html'))) return candidate + '/';
  }
  return '';
}

module.exports = { previewPagePrefix };
