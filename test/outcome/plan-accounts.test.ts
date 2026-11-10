import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  accountHeadroom,
  renderPlanLine,
  spendNext,
} from '../../src/outcome/plan-gauge.ts';

// Rows recorded verbatim in .krn/plan/samples.jsonl on 2026-11-10: an old row
// without resets, then one session reporting a second account's windows
// (seven-day reset 11-14) under the label of the account signed in at sampling.
const recorded = [
  '{"time":"2026-11-10T15:01:05Z","session":"91b5aba5-823a-4c4b-a857-b374ec5f1e2c","five_hour":88,"seven_day":50}',
  '{"time":"2026-11-10T15:04:10Z","session":"6f01a5c0-4412-48a9-858e-874e54ebc216","five_hour":45,"seven_day":74,"account":"f8e94cfd21f4","five_hour_resets":"2026-11-10T18:00:00Z","seven_day_resets":"2026-11-16T12:00:00Z"}',
  '{"time":"2026-11-10T15:19:48Z","session":"6f01a5c0-4412-48a9-858e-874e54ebc216","five_hour":58,"seven_day":76,"account":"f8e94cfd21f4","five_hour_resets":"2026-11-10T18:00:00Z","seven_day_resets":"2026-11-16T12:00:00Z"}',
  '{"time":"2026-11-10T15:20:40Z","session":"87b3855c-ba1d-4b63-9ebe-c11242f79b67","five_hour":32,"seven_day":96,"account":"f8e94cfd21f4","five_hour_resets":"2026-11-10T16:00:00Z","seven_day_resets":"2026-11-14T14:00:00Z"}',
  '{"time":"2026-11-10T15:20:41Z","session":"87b3855c-ba1d-4b63-9ebe-c11242f79b67","five_hour":58,"seven_day":76,"account":"f8e94cfd21f4","five_hour_resets":"2026-11-10T18:00:00Z","seven_day_resets":"2026-11-16T12:00:00Z"}',
  '{"time":"2026-11-10T15:30:46Z","session":"b6955db4-1c71-4b06-99a6-b505f7866204","five_hour":65,"seven_day":77,"account":"f8e94cfd21f4","five_hour_resets":"2026-11-10T18:00:00Z","seven_day_resets":"2026-11-16T12:00:00Z"}',
].join('\n');

const at = (iso: string) => Date.parse(iso);

test('recorded samples give points left per account and the nearest reset', () => {
  const accounts = accountHeadroom(recorded, at('2026-11-10T15:31:00Z'));
  assert.deepEqual(
    accounts.map((a) => [a.sevenDayResets, a.fiveHourLeft, a.sevenDayLeft]),
    [
      [at('2026-11-14T14:00:00Z'), 68, 4],
      [at('2026-11-16T12:00:00Z'), 35, 23],
    ],
  );
  assert.equal(
    renderPlanLine(accounts),
    'plan points left: 7d-reset 2026-11-14T14:00Z (f8e94cfd21f4) 5h 68 7d 4, ' +
      '7d-reset 2026-11-16T12:00Z (f8e94cfd21f4) 5h 35 7d 23; ' +
      'spend next 7d-reset 2026-11-14T14:00Z (f8e94cfd21f4)',
  );
});

test('a passed reset rolls the account into its next week with every point left', () => {
  const accounts = accountHeadroom(recorded, at('2026-11-14T15:00:00Z'));
  assert.deepEqual(
    accounts.map((a) => [a.sevenDayResets, a.fiveHourLeft, a.sevenDayLeft]),
    [
      [at('2026-11-16T12:00:00Z'), 100, 23],
      [at('2026-11-21T14:00:00Z'), 100, 100],
    ],
  );
  assert.equal(spendNext(accounts)?.sevenDayResets, at('2026-11-16T12:00:00Z'));
});

test('an account with no seven-day points left is not spent next', () => {
  const spent = recorded.replace('"seven_day":96', '"seven_day":100');
  const accounts = accountHeadroom(spent, at('2026-11-10T15:31:00Z'));
  assert.equal(spendNext(accounts)?.sevenDayResets, at('2026-11-16T12:00:00Z'));
  assert.equal(
    renderPlanLine(
      accountHeadroom(
        '{"time":"2026-11-10T15:01:05Z","session":"91b5aba5-823a-4c4b-a857-b374ec5f1e2c","five_hour":88,"seven_day":50}',
        0,
      ),
    ),
    'plan: no sample records its resets',
  );
});

// KRN-12: the real `krn plan` entry over a root holding the recorded rows.
test('krn plan prints the one line from the root samples', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-plan-'));
  mkdirSync(join(root, '.krn/plan'), { recursive: true });
  writeFileSync(join(root, '.krn/plan/samples.jsonl'), `${recorded}\n`);
  const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'plan', '--root', root], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^plan points left: .*; spend next .*\n$/u);
  assert.equal(run.stdout.split('\n').length, 2);
});
