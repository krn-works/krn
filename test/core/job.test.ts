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
