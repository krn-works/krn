import assert from 'node:assert/strict';
import { test } from 'node:test';

const smokeModulePath = new URL('../scripts/live-smoke.mjs', import.meta.url)
  .href;

test('live smoke ledger stub implements the foreman submission contract', async () => {
  const { createLiveSmokeLedger } = (await import(smokeModulePath)) as {
    createLiveSmokeLedger(): {
      readContract(issue: string): Promise<unknown>;
      submitForReview(): Promise<string>;
    };
  };
  const ledger = createLiveSmokeLedger();
  assert.equal(typeof ledger.submitForReview, 'function');
  assert.deepEqual(await ledger.readContract('smoke-issue'), {
    revision: 'live-smoke-checkpoint-v1',
    checks: ['checkpoint-file'],
  });
  assert.equal(await ledger.submitForReview(), 'submitted');
});
