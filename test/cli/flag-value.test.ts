import assert from 'node:assert/strict';
import test from 'node:test';
import { flagValue } from '../../src/cli-kit/flag-value.ts';

const missing = () => new Error('missing');

test('flag value accepts a free-text value that starts with --', () => {
  assert.equal(
    flagValue(['--note', '--force is gone'], 0, missing),
    '--force is gone',
  );
});

test('flag value accepts an empty value', () => {
  assert.equal(flagValue(['--note', ''], 0, missing), '');
});

test('flag value treats only an absent argument as missing', () => {
  assert.throws(() => flagValue(['--note'], 0, missing), /missing/);
});
