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
    { exitCode: 75 },
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
