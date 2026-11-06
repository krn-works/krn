import assert from 'node:assert/strict';
import test from 'node:test';

const api = await import('../../src/ci/wait.ts').catch(() => undefined);
const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const args = ['--repo', 'o/r', '--pr', '7', '--head', head, '--base', base];
function runtime(conclusion: string | null) {
  let time = 0;
  const gitReads: string[][] = [];
  return {
    gitReads,
    run: (_command: string, args: string[]) => {
      gitReads.push(args);
      return { code: 0, stdout: '', stderr: '' };
    },
    gh: async () =>
      JSON.stringify([
        {
          check_runs:
            conclusion === null
              ? []
              : [
                  {
                    id: 1,
                    name: 'gate',
                    head_sha: head,
                    status: 'completed',
                    conclusion,
                    app: { slug: 'github-actions' },
                    output: { title: 'failure cause' },
                  },
                ],
        },
      ]),
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}
test('wait succeeds and reads policy at exact base', async () => {
  assert.equal(typeof api?.waitCommand, 'function');
  const gate = await import('../../src/deliver/gate-wait.ts');
  assert.equal(typeof gate.waitForGate, 'function');
  assert.ok(api);
  const receiver = runtime('success');
  assert.equal(await api.waitCommand(args, receiver), `gate: success ${head}`);
  assert.deepEqual(receiver.gitReads[0], [
    'ls-tree',
    '--full-tree',
    base,
    '--',
    'spec/ci-admission.json',
  ]);
});
test('wait failure preserves rerun instruction and exits 74', async () => {
  assert.ok(api);
  await assert.rejects(
    api.waitCommand(args, runtime('failure')),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(Reflect.get(error, 'exitCode'), 74);
      assert.match(error.message, /gate concluded failure/);
      assert.ok(error.message.includes(`krn ci rerun --pr 7 --head ${head}`));
      assert.ok(!error.message.includes('\n'));
      return true;
    },
  );
});
test('wait times out with 75', async () => {
  assert.ok(api);
  await assert.rejects(
    api.waitCommand([...args, '--timeout-seconds', '1'], runtime(null)),
    {
      exitCode: 75,
      message: `bounded wait timed out after 1s: gate missing on ${head}; rerun the same command to resume`,
    },
  );
});
test('wait refuses usage with 64 before reading git', async () => {
  assert.ok(api);
  for (const invalid of [
    [],
    [...args, '--bad'],
    [...args, '--pr', '2'],
    [...args.slice(0, -2)],
    [...args, '--timeout-seconds', '0'],
  ])
    await assert.rejects(api.waitCommand(invalid), { exitCode: 64 });
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
    const { waitForGate, GateTimeout } = await import(
      '../../src/deliver/gate-wait.ts'
    );
    let time = 0;
    await assert.rejects(
      waitForGate({
        repo: 'o/r',
        pr: 7,
        head,
        policy: {
          source: 'pinned-app',
          checkRunName: 'krn/gate',
          appId: 5548482,
        },
        gh: async () =>
          JSON.stringify([
            {
              check_runs:
                time === 0
                  ? []
                  : [
                      {
                        id: 1,
                        name: 'krn/gate',
                        head_sha: head,
                        status,
                        conclusion: null,
                        app: { id: 5548482 },
                      },
                    ],
            },
          ]),
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
          `bounded wait timed out after 2s: krn/gate ${printed} on ${head}; rerun the same command to resume`,
        );
        assert.doesNotMatch(error.message, /[\p{Cc}\p{Cf}\u2028\u2029]/u);
        assert.ok(error.state.length <= 32);
        return true;
      },
    );
  });
}
