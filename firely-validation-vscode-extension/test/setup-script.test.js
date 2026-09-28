const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');

const execute = promisify(execFile);

test('downloads the .NET archive directly without invoking another installer', async () => {
  const script = await fs.readFile(path.join(__dirname, '..', 'install-tools.sh'), 'utf8');
  assert.match(script, /aka\.ms\/dotnet\/8\.0\/dotnet-sdk-/);
  assert.doesNotMatch(script, /dotnet-install/);
});

test('has a native Windows installer for the same validation tools', async () => {
  const script = await fs.readFile(path.join(__dirname, '..', 'install-tools.ps1'), 'utf8');
  assert.match(script, /\$ProgressPreference\s*=\s*'SilentlyContinue'/);
  assert.match(script, /Get-Command tar\.exe/);
  assert.match(script, /IO\.Compression\.ZipFile/);
  assert.match(script, /dotnet-sdk-win-\$architecture\.zip/);
  assert.match(script, /dotnet.+tool.+install.+Firely\.Terminal/s);
  assert.match(script, /npm.+install.+fsh-sushi/s);
  assert.match(script, /latest-v24\.x/);
});

test('setup exits without installing when every tool is available', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'firely setup '));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const bin = path.join(home, 'test-bin');
  await fs.mkdir(bin);

  for (const tool of ['dotnet', 'fhir', 'npm', 'sushi']) {
    const body = tool === 'dotnet'
      ? '#!/usr/bin/env bash\n[ "${1:-}" = --list-sdks ] && echo "8.0.418 [/dotnet/sdk]"\n'
      : `#!/usr/bin/env bash\necho "${tool} test version"\n`;
    await fs.writeFile(path.join(bin, tool), body, { mode: 0o755 });
  }

  const script = path.join(__dirname, '..', 'install-tools.sh');
  const { stdout } = await execute('bash', [script], {
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: path.join(home, 'data'),
      PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    },
  });

  assert.match(stdout, /Firely validation tools are ready/);
  assert.doesNotMatch(stdout, /Installing/);
});
