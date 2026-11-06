const { engines } = require('../package.json');

const minimumMajor = Number(engines.node.replace('>=', ''));
const currentMajor = Number(process.versions.node.split('.')[0]);

if (currentMajor < minimumMajor) {
  console.error(
    `Packaging requires Node.js ${minimumMajor} or newer; you are running ${process.version}.\n` +
    'Use Node.js 24 (see .nvmrc), or run from this directory:\n' +
    '  npx --yes --package=node@24 -- npm run package',
  );
  process.exitCode = 1;
}
