import assert from 'node:assert/strict';
import test from 'node:test';
import { requiredContexts } from '../../src/repo/required-check.ts';

test('a ruleset check with a null integration_id does not hide the Actions check beside it', () => {
  const rules = JSON.stringify([
    {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [
          { context: 'any-source-check', integration_id: null },
          { context: 'ci / Check', integration_id: 15368 },
        ],
      },
    },
  ]);
  assert.deepEqual(requiredContexts('{}', rules), ['ci / Check']);
});
