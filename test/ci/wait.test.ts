import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { stopExitCodes, waitCommand, waitUsage } from '../../src/ci/wait.ts';
import { GateTimeout, waitForGate } from '../../src/deliver/gate-wait.ts';
import { checkRunArgs, pull, pullArgs, strictGh } from './strict-gh.ts';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const args = ['--repo', 'o/r', '--pr', '7', '--head', head, '--base', base];
const checkRun = (status: string, conclusion: string | null) => ({
  id: 1,
  name: 'gate',
  head_sha: head,
  status,
  conclusion,
  app: { slug: 'github-actions' },
  output: { title: 'failure cause' },
});
function runtime(
  checks: () => unknown[],
  pullBody: () => string = () => pull(head),
) {
  let time = 0;
  const gitReads: string[][] = [];
  const fake = strictGh('o/r', 7, head, {
    pull: pullBody,
    checks: () => JSON.stringify([{ check_runs: checks() }]),
  });
  return {
    gitReads,
    calls: fake.calls,
    elapsed: () => time,
    run: (_command: string, args: string[]) => {
      gitReads.push(args);
      return { code: 0, stdout: '', stderr: '' };
    },
    gh: fake.gh,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}
test('wait succeeds and reads policy at exact base', async () => {
  const receiver = runtime(() => [checkRun('completed', 'success')]);
  assert.equal(
    await waitCommand(args, receiver),
    `gate: success ${head}\nverdict: not merging: auto-merge is not enabled on PR #7 (mergeable_state blocked); run gh pr merge 7 --auto --squash`,
  );
  assert.deepEqual(receiver.gitReads[0], [
    'ls-tree',
    '--full-tree',
    base,
    '--',
    'spec/ci-admission.json',
  ]);
  assert.deepEqual(receiver.calls, [
    pullArgs('o/r', 7),
    checkRunArgs('o/r', head),
  ]);
});
test('wait failure preserves rerun instruction and exits 74', async () => {
  await assert.rejects(
    waitCommand(
      args,
      runtime(() => [checkRun('completed', 'failure')]),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(Reflect.get(error, 'exitCode'), 74);
      assert.match(error.message, /concluded failure/);
      assert.ok(error.message.includes('gh run rerun <run-id> --failed'));
      assert.ok(!error.message.includes('\n'));
      return true;
    },
  );
});
test('wait failure on a captured Actions Check names its run and ci logs command', async () => {
  // Verbatim `gh api --paginate --slurp .../check-runs` for a PR head whose
  // Check failed twice in Actions run 42470866515 (KRN-12).
  const captured = '8fba0398db07784982a5e8d6a4d61392fa452857';
  const page = await readFile(
    new URL(
      '../fixtures/github-check-runs/actions-check-failure.json',
      import.meta.url,
    ),
    'utf8',
  );
  const policy = await readFile(
    new URL('../../spec/ci-admission.json', import.meta.url),
    'utf8',
  );
  const blob = 'c'.repeat(40);
  const { gh } = strictGh('krn-works/krn', 1, captured, {
    pull: () => pull(captured),
    checks: () => page,
  });
  await assert.rejects(
    waitCommand(
      [
        '--repo',
        'krn-works/krn',
        '--pr',
        '1',
        '--head',
        captured,
        '--base',
        base,
      ],
      {
        gh,
        run: (_command: string, gitArgs: string[]) => ({
          code: 0,
          stdout:
            gitArgs[0] === 'ls-tree'
              ? `100644 blob ${blob}\tspec/ci-admission.json\n`
              : policy,
          stderr: '',
        }),
        sleep: async () => {},
        now: () => 0,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(Reflect.get(error, 'exitCode'), 74);
      assert.equal(
        error.message,
        `Check concluded failure on ${captured} in run 42470866515; logs: bin/krn ci logs --run 42470866515; rerun: gh run rerun 42470866515 --failed`,
      );
      return true;
    },
  );
});
test('wait times out with 75 while the gate is queued', async () => {
  await assert.rejects(
    waitCommand(
      [...args, '--timeout-seconds', '1'],
      runtime(() => [checkRun('queued', null)]),
    ),
    {
      exitCode: 75,
      message: `bounded wait timed out after 1s: gate queued on ${head}; rerun the same command to resume`,
    },
  );
});
test('a conflicting PR without check-runs stops on the first poll', async () => {
  const receiver = runtime(
    () => [],
    () => pull(head, 'dirty'),
  );
  await assert.rejects(waitCommand(args, receiver), {
    exitCode: stopExitCodes.conflict,
    message: /PR #7 conflicts with its base/u,
  });
  assert.equal(receiver.elapsed(), 0);
  assert.equal(receiver.calls.length, 1);
});
test('a moved head stops on the first poll', async () => {
  const receiver = runtime(
    () => [checkRun('completed', 'success')],
    () => pull('c'.repeat(40)),
  );
  await assert.rejects(waitCommand(args, receiver), {
    exitCode: stopExitCodes['head-moved'],
    message: /^head moved: PR #7 is at c{40}, not a{40}/u,
  });
  assert.equal(receiver.elapsed(), 0);
});
test('a gate that never starts stops at the start bound, long before 1800 s', async () => {
  const receiver = runtime(() => []);
  await assert.rejects(
    waitCommand([...args, '--start-timeout-seconds', '60'], receiver),
    {
      exitCode: stopExitCodes['never-started'],
      message: `gate never started on ${head} within 60s; check the PR's workflows`,
    },
  );
  assert.equal(receiver.elapsed(), 60_000);
});
test('a gate that starts in time is not cut by the start bound', async () => {
  let polls = 0;
  const receiver = runtime(() =>
    ++polls < 3
      ? []
      : [checkRun(polls < 5 ? 'in_progress' : 'completed', 'success')],
  );
  assert.equal(
    await waitCommand([...args, '--start-timeout-seconds', '30'], receiver),
    `gate: success ${head}\nverdict: not merging: auto-merge is not enabled on PR #7 (mergeable_state blocked); run gh pr merge 7 --auto --squash`,
  );
  assert.equal(receiver.elapsed(), 40_000);
});
test('stop exit codes are distinct, avoid 64/74/75 and appear in the usage', () => {
  const codes = Object.values(stopExitCodes);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) {
    assert.ok(![0, 64, 74, 75].includes(code));
    assert.match(waitUsage, new RegExp(`\\b${code}\\b`, 'u'));
  }
  assert.match(waitUsage, /--start-timeout-seconds/u);
});
test('wait refuses usage with 64 before reading git', async () => {
  for (const invalid of [
    [],
    [...args, '--bad'],
    [...args, '--pr', '2'],
    [...args.slice(0, -2)],
    [...args, '--timeout-seconds', '0'],
    [...args, '--start-timeout-seconds', '0'],
  ])
    await assert.rejects(waitCommand(invalid), { exitCode: 64 });
});

for (const [status, printed] of [
  ['in_progress', 'in_progress'],
  ['queued\ninjected', 'queued'],
  ['queued\rinjected', 'queued'],
  ['queued\u2028injected', 'queued'],
  ['queued\u2029injected', 'queued'],
  ['\u0000in\u001b_\u200bprogress\u007f', 'in_progress'],
  ['q'.repeat(40), 'q'.repeat(32)],
]) {
  test(`timeout reports the last seen state safely: ${JSON.stringify(status)}`, async () => {
    let time = 0;
    const { gh } = strictGh('o/r', 7, head, {
      pull: () => pull(head),
      checks: () =>
        JSON.stringify([
          {
            check_runs:
              time === 0
                ? []
                : [
                    {
                      id: 1,
                      name: 'Check',
                      head_sha: head,
                      status,
                      conclusion: null,
                      app: { id: 15368 },
                    },
                  ],
          },
        ]),
    });
    await assert.rejects(
      waitForGate({
        repo: 'o/r',
        pr: 7,
        head,
        policy: { source: 'pinned-app', checkRunName: 'Check', appId: 15368 },
        gh,
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
        pollMs: 1000,
        timeoutMs: 2000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GateTimeout);
        assert.equal(error.seconds, 2);
        assert.equal(error.state, printed);
        assert.equal(
          error.message,
          `bounded wait timed out after 2s: Check ${printed} on ${head}; rerun the same command to resume`,
        );
        assert.doesNotMatch(error.message, /[\p{Cc}\p{Cf}\u2028\u2029]/u);
        assert.ok(error.state.length <= 32);
        return true;
      },
    );
  });
}

function mergeRuntime(
  pulls: Array<Record<string, unknown>>,
  refresh: { code: number; stdout: string; stderr: string },
) {
  let time = 0;
  const runs: Array<[string, string[]]> = [];
  const fake = strictGh('o/r', 7, head, {
    pull: () =>
      JSON.stringify({
        head: { sha: head },
        mergeable_state: 'blocked',
        ...(pulls.length > 1 ? pulls.shift() : pulls[0]),
      }),
    checks: () =>
      JSON.stringify([{ check_runs: [checkRun('completed', 'success')] }]),
  });
  return {
    runs,
    gh: fake.gh,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    run: (command: string, args: string[]) => {
      runs.push([command, args]);
      return command === 'bash' ? refresh : { code: 0, stdout: '', stderr: '' };
    },
  };
}
const merge = 'c'.repeat(40);
const autoMerge = { auto_merge: { merge_method: 'squash' }, state: 'open' };

test('wait refreshes the pinned Product entry once the auto-merging PR merges', async () => {
  const receiver = mergeRuntime(
    [
      autoMerge,
      autoMerge,
      { state: 'closed', merged: true, merge_commit_sha: merge },
    ],
    {
      code: 0,
      stdout: `entry=/x/bin/krn\nprevious=${base}\ncommit=${merge}\n`,
      stderr: '',
    },
  );
  assert.equal(
    await waitCommand(args, receiver),
    [
      `gate: success ${head}`,
      `merged: ${merge}`,
      'release: entry=/x/bin/krn',
      `release: previous=${base}`,
      `release: commit=${merge}`,
      `verdict: merged ${merge}`,
    ].join('\n'),
  );
  const refreshes = receiver.runs.filter(([command]) => command === 'bash');
  assert.equal(refreshes.length, 1);
  assert.match(refreshes[0]?.[1][0] ?? '', /scripts\/product-release\.sh$/u);
});

test('a failed refresh after the merge still reports merged, with a warning', async () => {
  const receiver = mergeRuntime(
    [autoMerge, { state: 'closed', merged: true, merge_commit_sha: merge }],
    {
      code: 78,
      stdout: '',
      stderr: `product-release: candidate ${merge} failed bin/krn doctor; kept previous=${base}\n`,
    },
  );
  const out = await waitCommand(args, receiver);
  assert.match(
    out,
    new RegExp(
      `^warning: release refresh failed \\(exit 78\\).*kept previous=${base}`,
      'mu',
    ),
  );
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
});

test('wait without auto-merge skips the refresh; an unseen merge prints the manual step', async () => {
  const plain = mergeRuntime([{ auto_merge: null }], {
    code: 1,
    stdout: '',
    stderr: '',
  });
  assert.equal(
    await waitCommand(args, plain),
    `gate: success ${head}\nverdict: not merging: auto-merge is not enabled on PR #7 (mergeable_state blocked); run gh pr merge 7 --auto --squash`,
  );
  assert.equal(plain.runs.filter(([command]) => command === 'bash').length, 0);

  const pending = mergeRuntime([autoMerge], {
    code: 1,
    stdout: '',
    stderr: '',
  });
  assert.equal(
    await waitCommand([...args, '--merge-timeout-seconds', '30'], pending),
    `gate: success ${head}\nmerge: not observed within 30s; after it merges run scripts/product-release.sh\nverdict: open: auto-merge enabled but PR #7 is blocked (review or another required rule blocks it)`,
  );
  assert.equal(
    pending.runs.filter(([command]) => command === 'bash').length,
    0,
  );
});

test('a PR closed without merging ends with an unmerged verdict', async () => {
  const closed = mergeRuntime(
    [autoMerge, { state: 'closed', merged: false, auto_merge: null }],
    { code: 1, stdout: '', stderr: '' },
  );
  assert.equal(
    await waitCommand(args, closed),
    `gate: success ${head}\nmerge: PR closed without merging\nverdict: closed unmerged PR #7`,
  );
});
