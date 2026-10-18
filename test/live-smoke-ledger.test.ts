import assert from 'node:assert/strict';
import { test } from 'node:test';

const smokeModulePath = new URL('../scripts/live-smoke.mjs', import.meta.url)
  .href;

test('live smoke ledger stub implements the foreman submission contract', async () => {
  const { createLiveSmokeLedger } = (await import(smokeModulePath)) as {
    createLiveSmokeLedger(targetRepo?: string): {
      readContract(issue: string): Promise<{
        issueId: string;
        identifier: string;
        title: string;
        description: string;
        revision: string;
        targetRepo: string;
        checks: readonly string[];
      }>;
      submitForReview(): Promise<string>;
    };
  };
  const ledger = createLiveSmokeLedger('smoke-target');
  assert.equal(typeof ledger.submitForReview, 'function');
  assert.deepEqual(await ledger.readContract('smoke-issue'), {
    issueId: 'smoke-issue',
    identifier: 'smoke-issue',
    title: 'Live smoke contract for smoke-issue',
    description: '',
    revision: 'live-smoke-checkpoint-v1',
    targetRepo: 'smoke-target',
    checks: ['checkpoint-file'],
  });
  assert.equal(await ledger.submitForReview(), 'submitted');
});
