import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePaperclipIssue } from '../../src/core/paperclip.ts';

test('malformed Paperclip issue payload is returned as a Result error', () => {
  let result: ReturnType<typeof parsePaperclipIssue> | undefined;
  assert.doesNotThrow(() => {
    result = parsePaperclipIssue({});
  });
  assert.equal(result?.ok, false);
});

test('complete Paperclip issue retains updatedAt and status', () => {
  const issue = {
    id: 'issue-1',
    identifier: 'LON-217',
    title: 'Remove duplicate schema',
    description: 'A complete issue payload.',
    updatedAt: '2026-10-10T10:00:00.000Z',
    status: 'todo',
  };

  const result = parsePaperclipIssue(issue);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.updatedAt, issue.updatedAt);
    assert.equal(result.value.status, issue.status);
  }
});
