import assert from 'node:assert/strict';
import test from 'node:test';
import { runCanary, touchesLane } from '../../scripts/lane-canary.ts';

test('the canary path filter selects lane, adopt and ci changes only', () => {
  assert.equal(touchesLane(['src/cli/lane-run.ts']), true);
  assert.equal(touchesLane(['src/cli/lane/x.ts']), true);
  assert.equal(touchesLane(['README.md', 'src/adopt/init.ts']), true);
  assert.equal(touchesLane(['src/ci/ship.ts']), true);
  assert.equal(
    touchesLane(['src/cli/krn.mjs', 'src/outcome/window.ts']),
    false,
  );
  assert.equal(touchesLane(['test/ci/x.test.ts', 'src/cilantro.ts']), false);
  assert.equal(touchesLane([]), false);
});

test('the canary passes a delivering lane and fails a lane that commits nothing', async () => {
  const ok = await runCanary();
  assert.equal(ok.exitCode, 0, ok.line);
  const broken = await runCanary({ deliver: false });
  assert.notEqual(broken.exitCode, 0, broken.line);
});
