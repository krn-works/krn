import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandLines, isCommand } from '../../src/cli/help.ts';
import { dispatch } from '../../src/cli/index.ts';

test('the router and the help text share one command list', async () => {
  assert.equal(isCommand('lane'), true);
  assert.equal(isCommand('review'), false);
  assert.equal(isCommand('toString'), false);
  assert.ok(commandLines().length >= 14);
  assert.equal(await dispatch(['nope']), false);
});
