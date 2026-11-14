import assert from 'node:assert/strict';
import { test } from 'node:test';
import { titleTaskId } from '../../src/outcome/task-id.ts';

test('titleTaskId reads the trailing task id of a PR title', () => {
  assert.equal(titleTaskId('fix(ship): regenerate (t-hrew57z)'), 't-hrew57z');
  assert.equal(titleTaskId('fix(ship): regenerate (t-hrew57z) '), 't-hrew57z');
  assert.equal(titleTaskId('fix: no id'), undefined);
  assert.equal(titleTaskId('fix (t-hrew57z): mid'), undefined);
});
