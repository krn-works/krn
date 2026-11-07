import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { base, flag, setup } from './nontechnical-blocker-fixture.ts';

test('a vague blocker on a report with no changes is flagged and an exit blocker with a command is not, on start and send', async (t) => {
  for (const [name, report, flagged] of [
    ['vague partial', { blockers: ['no time left'] }, true],
    ['empty blocked', { status: 'blocked' }, true],
    ['exit without command', { blockers: ['exit 1'] }, true],
    ['command exit', { blockers: ['npm test exit 1'] }, false],
    [
      'exited with exit code',
      {
        status: 'blocked',
        blockers: ['node --test x.ts exited with exit code 2'],
      },
      false,
    ],
  ] as const) {
    await t.test(name, async (t) => {
      const s = await setup(t);
      writeFileSync(
        join(s.root, 'report'),
        JSON.stringify({ ...base, ...report }),
      );
      for (const [first, round] of [
        [true, '001'],
        [false, '002'],
      ] as const) {
        const result = await s.turn('custom-report', first);
        assert.equal(result.code, 4, result.stderr);
        const recorded = s.json(`rounds/${round}/result.json`);
        assert.equal(recorded.nontechnical_blocker, flagged, round);
        if (flagged) {
          assert.match(result.stderr, flag);
          assert.match(recorded.message, flag);
        } else {
          assert.doesNotMatch(result.stderr, flag);
          assert.doesNotMatch(recorded.message, flag);
        }
      }
    });
  }
});
test('a clean done report records no non-technical blocker', async (t) => {
  const s = await setup(t);
  const result = await s.turn('done-clean', true);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, flag);
  assert.equal(s.json('rounds/001/result.json').nontechnical_blocker, false);
});
