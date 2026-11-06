const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const script = path.resolve(__dirname, '../install-preview-tools.sh');

async function fixture(t, { rubyMissing = false, platform = 'Linux', gemFailure = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "preview setup ' ! $ literal "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'commands');
  const installRoot = path.join(root, 'preview');
  const state = path.join(root, 'ruby-ready');
  const calls = path.join(root, 'calls');
  await fs.mkdir(bin);
  await fs.writeFile(calls, '');
  if (!rubyMissing) await fs.writeFile(state, 'ready');
  async function command(name, body) {
    await fs.writeFile(path.join(bin, name), '#!/usr/bin/env bash\nset -euo pipefail\n' + body + '\n', { mode: 0o755 });
  }
  await command('ruby', `
printf '%s\\n' "ruby $*" >> "$PREVIEW_TEST_CALLS"
case "$1" in
  -rrubygems) [[ -f "$PREVIEW_TEST_STATE" ]];;
  -rrbconfig)
    if [[ "$*" == *'print RbConfig.ruby'* ]]; then
      printf '%s' "$PREVIEW_TEST_RUBY"
    else
      [[ -f "$PREVIEW_TEST_STATE" ]]
    fi;;
  -S)
    [[ "$PREVIEW_TEST_GEM_FAILURE" != 1 ]] || exit 9
    mkdir -p "$GEM_HOME/bin"
    touch "$GEM_HOME/bin/jekyll";;
  *)
    [[ "$GEM_HOME" == "$PREVIEW_TEST_INSTALL/gems" ]]
    [[ "$GEM_PATH" == "$GEM_HOME" ]]
    [[ -f "$1" ]]
    echo 'jekyll 4.4.1';;
esac`);
  await command('uname', `echo '${platform}'`);
  await command('id', 'echo 0');
  for (const name of ['cc', 'make']) await command(name, 'exit 0');
  await command('apt-get', 'printf "%s\\n" "apt-get $*" >> "$PREVIEW_TEST_CALLS"\ntouch "$PREVIEW_TEST_STATE"');
  await command('brew', `
printf '%s\\n' "brew $*" >> "$PREVIEW_TEST_CALLS"
if [[ "$1" == --prefix ]]; then
  printf '%s' "$PREVIEW_TEST_BREW"
else
  touch "$PREVIEW_TEST_STATE"
fi`);
  for (const tool of ['dotnet', 'fhir', 'npm', 'sushi', 'sudo', 'curl', 'wget']) {
    await command(tool, `echo 'Unexpected tool: ${tool}' >&2\nexit 99`);
  }
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    PREVIEW_TEST_STATE: state, PREVIEW_TEST_CALLS: calls,
    PREVIEW_TEST_INSTALL: installRoot, PREVIEW_TEST_RUBY: path.join(bin, 'ruby'),
    PREVIEW_TEST_BREW: root, PREVIEW_TEST_GEM_FAILURE: gemFailure ? '1' : '0',
  };
  return { installRoot, calls, env, launcher: path.join(installRoot, 'bin', 'jekyll') };
}

test('installs isolated preview gems with existing Ruby and reuses them on later runs', { skip: process.platform === 'win32' }, async (t) => {
  const { installRoot, calls, env, launcher } = await fixture(t);
  const { stdout } = await execute('bash', [script, installRoot], { env });
  assert.match(stdout, /Preview dependencies are ready/);
  const firstCalls = await fs.readFile(calls, 'utf8');
  assert.match(firstCalls, /install .*jekyll --version 4\.4\.1/);
  assert.match(firstCalls, /install .*bundler --version ~> 2\.6\.0/);
  assert.doesNotMatch(firstCalls, /apt-get|brew/);
  assert.match((await execute(launcher, ['--version'], { env })).stdout, /jekyll 4\.4\.1/);
  await fs.writeFile(calls, '');
  await execute('bash', [script, installRoot], { env });
  assert.doesNotMatch(await fs.readFile(calls, 'utf8'), /install/);
});

for (const platform of ['Linux', 'Darwin']) {
  test(`installs missing Ruby using the ${platform} package manager before installing preview gems`, { skip: process.platform === 'win32' }, async (t) => {
    const { installRoot, calls, env } = await fixture(t, { rubyMissing: true, platform });
    await execute('bash', [script, installRoot], { env });
    const invoked = await fs.readFile(calls, 'utf8');
    assert.match(invoked, platform === 'Linux' ? /apt-get install -y ruby-full build-essential zlib1g-dev/ : /brew install ruby@3\.4/);
    assert.match(invoked, /install .*jekyll/);
  });
}

test('failed gem installation does not publish a broken managed launcher', { skip: process.platform === 'win32' }, async (t) => {
  const { installRoot, env, launcher } = await fixture(t, { gemFailure: true });
  await assert.rejects(execute('bash', [script, installRoot], { env }), (error) => error.code === 9);
  await assert.rejects(fs.access(launcher), { code: 'ENOENT' });
});
