import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  advisories,
  line,
  restartBlocks,
  rolloutTurns,
} from '../../scripts/codex/hook-probe.ts';

// Lines of a real codex-cli 0.167.0 rollout (`codex exec resume <id> -c
// model_auto_compact_token_limit=20000` before the restart dedupe): both
// task_started events, the compacted line without its replacement history,
// and every hook injection cut to its first line. Codex drained resume then
// compact in one turn, so the KRN restart block and the global capsule each
// landed twice.
const captured = readFileSync(
  new URL(
    '../fixtures/codex-hooks/rollout-resume-compact.jsonl',
    import.meta.url,
  ),
  'utf8',
);

test('the probe counts restart blocks of the final turn from a real rollout', () => {
  const turns = rolloutTurns(captured);
  assert.equal(turns.last, '01a1c097-00f6-7b60-a54a-c63fee821104');
  assert.equal(turns.compactions, 1);
  assert.equal(
    turns.injections.length,
    6,
    'startup pair and both resume pairs',
  );
  assert.equal(restartBlocks(turns), 2, 'the duplicate the dedupe removes');
  assert.equal(advisories(turns), 0);
  const startup = rolloutTurns(captured.split('\n').slice(0, 3).join('\n'));
  assert.equal(restartBlocks(startup), 1);
});

test('the probe prints one PASS or FAIL line per event', () => {
  assert.equal(
    line({ event: 'SessionStart fork', pass: false, detail: '0 blocks' }),
    'FAIL SessionStart fork: 0 blocks',
  );
  assert.equal(
    line({ event: 'PreCompact', pass: true, detail: 'receipt' }),
    'PASS PreCompact: receipt',
  );
});
