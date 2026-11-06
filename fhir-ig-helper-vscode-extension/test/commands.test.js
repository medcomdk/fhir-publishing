const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCommandRunner } = require('../src/commands');

test('runs commands as ordinary child processes by default', async () => {
  let receivedOptions;
  const commands = createCommandRunner({
    cwd: '/workspace',
    log() {},
    async run(command, args, options) {
      receivedOptions = options;
      return { code: 0, output: '' };
    },
  });

  await commands.runRequiredCommand('npm', ['install']);

  assert.equal(receivedOptions.processGroup, false);
});
