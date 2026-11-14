import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../../src/successor/launch.ts';
import { parseArgs } from '../../src/successor/options.ts';
import {
  handleStopFailure,
  RELAUNCH_LIMIT,
  type WatchdogDeps,
} from '../../src/successor/watchdog.ts';

// StopFailure payload as the Claude Code hooks reference words it.
const payload = {
  session_id: 'abc123',
  transcript_path: '/home/u/.claude/projects/p/abc123.jsonl',
  cwd: '/repo',
  hook_event_name: 'StopFailure',
  error: 'rate_limit',
  error_details: '429 Too Many Requests',
  last_assistant_message: 'API Error: Rate limit reached',
};

function repo(fiveHour?: number): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-watchdog-'));
  mkdirSync(join(root, '.krn/runs/lead/x'), { recursive: true });
  writeFileSync(join(root, '.krn/runs/lead/x/handoff.md'), '## Resume\n');
  if (fiveHour !== undefined) {
    mkdirSync(join(root, '.krn/plan'), { recursive: true });
    writeFileSync(
      join(root, '.krn/plan/samples.jsonl'),
      `${JSON.stringify({ time: 't', session: 's', five_hour: fiveHour, seven_day: 1 })}\n`,
    );
  }
  return root;
}

function deps(calls: string[][], status = 0): WatchdogDeps {
  return {
    now: () => 1_000_000,
    run: (command, args) => {
      calls.push([command, ...args]);
      return status;
    },
  };
}

test('a rate-limit StopFailure relaunches an unattended lead through the unattended launcher', () => {
  const root = repo(10);
  const calls: string[][] = [];
  const outcome = handleStopFailure(
    payload,
    root,
    { KRN_UNATTENDED: '1' },
    deps(calls),
  );
  assert.equal(outcome.action, 'relaunched');
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.includes('--unattended'));
  assert.ok(calls[0]?.some((part) => part.endsWith('successor-launch.ts')));
});

test('the account switches before the relaunch when the 5h window is above 85 percent', () => {
  const root = repo(90);
  const calls: string[][] = [];
  const outcome = handleStopFailure(
    payload,
    root,
    { KRN_UNATTENDED: '1' },
    deps(calls),
  );
  assert.deepEqual(calls[0], ['cswap', 'switch']);
  assert.equal(calls.length, 2);
  assert.equal(outcome.action === 'relaunched' && outcome.switched, true);
});

test('an attended session, a non-transient error and a missing handoff relaunch nothing', () => {
  const calls: string[][] = [];
  assert.equal(
    handleStopFailure(payload, repo(), {}, deps(calls)).action,
    'ignored',
  );
  assert.equal(
    handleStopFailure(
      { ...payload, error: 'invalid_request' },
      repo(),
      { KRN_UNATTENDED: '1' },
      deps(calls),
    ).action,
    'ignored',
  );
  const bare = mkdtempSync(join(tmpdir(), 'krn-watchdog-bare-'));
  assert.equal(
    handleStopFailure(payload, bare, { KRN_UNATTENDED: '1' }, deps(calls))
      .action,
    'refused',
  );
  assert.deepEqual(calls, []);
});

test('a successor that keeps dying is relaunched at most RELAUNCH_LIMIT times an hour', () => {
  const root = repo();
  const calls: string[][] = [];
  const env = { KRN_UNATTENDED: '1' };
  for (let n = 0; n < RELAUNCH_LIMIT; n++)
    assert.equal(
      handleStopFailure(payload, root, env, deps(calls)).action,
      'relaunched',
    );
  assert.equal(
    handleStopFailure(payload, root, env, deps(calls)).action,
    'refused',
  );
  assert.equal(
    readFileSync(join(root, '.krn/runs/watchdog/relaunches.log'), 'utf8')
      .trim()
      .split('\n').length,
    RELAUNCH_LIMIT,
  );
});

test('a failed launch is refused and not counted', () => {
  const root = repo();
  const outcome = handleStopFailure(
    payload,
    root,
    { KRN_UNATTENDED: '1' },
    deps([], 75),
  );
  assert.deepEqual(outcome, {
    action: 'refused',
    reason: 'successor launch exited 75',
  });
});

test('launcher: a failed unattended doctor exits non-zero before any harness is touched', () => {
  const args = ['--unattended', '--name', 'n', '--prompt', 'run its Verify'];
  assert.equal(parseArgs(args).unattended, true);
  assert.equal(parseArgs(args.slice(1)).unattended, false);
  assert.equal(
    main(args, () => ({ text: 'FAIL mint: no App token', exitCode: 69 })),
    69,
  );
  assert.equal(main(args), 1);
});

test('the hook script reads the StopFailure payload from stdin and reports its outcome', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-watchdog-hook-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  const run = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../scripts/claude/stop-failure.ts', import.meta.url),
      ),
    ],
    {
      input: JSON.stringify({ ...payload, cwd: root }),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', KRN_UNATTENDED: '1' },
    },
  );
  assert.equal(run.status, 0);
  assert.match(run.stderr, /"action":"refused".*no handoff\.md/u);
});
