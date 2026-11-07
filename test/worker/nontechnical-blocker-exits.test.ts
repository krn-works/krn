import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { base, flag, setup } from './nontechnical-blocker-fixture.ts';

test('timeout and exit status blockers and changed paths are not flagged on start and send', async (t) => {
  for (const [name, report, flagged] of [
    ['timeout', { blockers: ['tsc timed out after 600 s'] }, false],
    ['bare timeout', { blockers: ['timed out'] }, false],
    ['exit status', { blockers: ['biome check: Exit Status 1'] }, false],
    [
      'changed paths',
      { changed_paths: ['src/a.ts'], blockers: ['no time left'] },
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
