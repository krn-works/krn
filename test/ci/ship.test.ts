import assert from 'node:assert/strict';
import test from 'node:test';
import { shipCommand } from '../../src/ci/ship.ts';

// KRN-12: the fake git and gh answer only the exact calls ship may make, with
// output shaped like the real tools (gh pr create prints the PR url).
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const merge = 'c'.repeat(40);
const title = 'feat(ci): ship a PR in one call (t-3ag9eqn)';
const args = ['--title', title, '--body-file', 'body.md', '--repo', 'o/r'];
type Failure = Error & { exitCode?: number };

function receiver(options: {
  pulls: Array<Record<string, unknown>>;
  check?: string;
  existing?: string;
  dirty?: boolean;
  branch?: string;
}) {
  let time = 0;
  const calls: string[] = [];
  const pulls = [...options.pulls];
  const gh = async (a: string[]): Promise<string> => {
    calls.push(`gh ${a.join(' ')}`);
    if (a[0] === 'pr' && a[1] === 'list') return options.existing ?? '';
    if (a[0] === 'pr' && a[1] === 'create')
      return 'https://github.com/o/r/pull/7\n';
    if (a[0] === 'pr') return '';
    if (a[1] === 'repos/o/r/pulls/7') {
      const next = pulls.length > 1 ? pulls.shift() : pulls[0];
      return JSON.stringify({
        head: { sha: head },
        mergeable_state: 'blocked',
        ...next,
      });
    }
    if (a.some((x) => x.includes('/check-runs')))
      return JSON.stringify([
        {
          check_runs: [
            {
              id: 1,
              name: 'gate',
              head_sha: head,
              status: 'completed',
              conclusion: options.check ?? 'success',
              app: { slug: 'github-actions' },
              output: { title: 'x' },
            },
          ],
        },
      ]);
    assert.fail(`unexpected gh call ${a.join(' ')}`);
  };
  const run = (command: string, a: string[]) => {
    calls.push(`${command} ${a.join(' ')}`);
    const out = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (command === 'bash') return out(`commit=${merge}\n`);
    const line = a.join(' ');
    if (line === 'rev-parse --abbrev-ref HEAD')
      return out(`${options.branch ?? 'feat-x'}\n`);
    if (a[0] === 'status') return out(options.dirty ? ' M f\n' : '');
    if (line === 'rev-parse HEAD') return out(`${head}\n`);
    if (line === 'rev-parse origin/main') return out(`${base}\n`);
    if (line === 'rev-parse --show-toplevel')
      return out('/r/.krn/worktrees/feat-x\n');
    if (a.includes('--git-common-dir')) return out('/r/.git\n');
    if (['push', 'fetch', 'worktree', 'branch', 'ls-tree'].includes(a[0] ?? ''))
      return out('');
    assert.fail(`unexpected ${command} ${line}`);
  };
  return {
    calls,
    run,
    gh,
    cwd: '/r/.krn/worktrees/feat-x',
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}
const auto = { auto_merge: { merge_method: 'squash' }, state: 'open' };
const merged = { state: 'closed', merged: true, merge_commit_sha: merge };

test('ship pushes, creates, auto-merges, waits through the merge and cleans up', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const out = await shipCommand(args, r);
  assert.match(out, /^pr: #7 o\/r a{40}$/mu);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.match(
    out,
    /^cleanup: removed worktree \/r\/\.krn\/worktrees\/feat-x and branch feat-x$/mu,
  );
  const order = [
    'push -u origin feat-x',
    'gh pr list',
    'gh pr create',
    'gh pr merge 7 --repo o/r --auto --squash',
    'worktree remove --force /r/.krn/worktrees/feat-x',
    'branch -D feat-x',
  ];
  let at = -1;
  for (const step of order) {
    const found = r.calls.findIndex((c, i) => i > at && c.includes(step));
    assert.ok(found > at, `${step} out of order in ${r.calls.join('\n')}`);
    at = found;
  }
  assert.ok(r.calls.some((c) => c.includes(`--title ${title}`)));
});

test('ship reuses the open PR of the branch instead of creating another', async () => {
  const r = receiver({ pulls: [auto, merged], existing: '7\n' });
  await shipCommand([...args, '--force'], r);
  assert.ok(
    r.calls.some((c) => c.includes('push -u --force-with-lease origin feat-x')),
  );
  assert.ok(!r.calls.some((c) => c.startsWith('gh pr create')));
  assert.ok(r.calls.some((c) => c.startsWith('gh pr edit 7')));
});

test('a red Check exits 74 and keeps the worktree', async () => {
  const r = receiver({ pulls: [auto], check: 'failure' });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 74);
    return true;
  });
  assert.ok(!r.calls.some((c) => c.includes('worktree remove')));
});

test('a conflicting PR exits 76 and keeps the worktree', async () => {
  const r = receiver({ pulls: [{ mergeable_state: 'dirty' }] });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 76);
    return true;
  });
  assert.ok(!r.calls.some((c) => c.includes('worktree remove')));
});

test('a refused title, main branch or dirty tree exits 64 before any push', async () => {
  const cases: Array<[string[], ReturnType<typeof receiver>]> = [
    [
      ['--title', 'Ship it (t-3ag9eqn)', '--body-file', 'b', '--repo', 'o/r'],
      receiver({ pulls: [auto] }),
    ],
    [args, receiver({ pulls: [auto], branch: 'main' })],
    [args, receiver({ pulls: [auto], dirty: true })],
    [['--body-file', 'b'], receiver({ pulls: [auto] })],
  ];
  for (const [argv, rec] of cases) {
    await assert.rejects(shipCommand(argv, rec), (e: Failure) => {
      assert.equal(e.exitCode, 64);
      return true;
    });
    assert.ok(!rec.calls.some((c) => c.includes('push')));
  }
});
