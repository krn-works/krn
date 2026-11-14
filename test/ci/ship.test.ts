import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { shipCommand } from '../../src/ci/ship.ts';
import { CommandFailure } from '../../src/deliver/transport.ts';

// KRN-12: the fake git and gh answer only the exact calls ship may make, with
// output shaped like the real tools (gh pr create prints the PR url).
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const merge = 'c'.repeat(40);
const title = 'feat(ci): ship a PR in one call (t-3ag9eqn)';
const args = ['--title', title, '--body-file', 'body.md', '--repo', 'o/r'];
type Failure = Error & { exitCode?: number };

const line0 = (a: string[]) => a.join(' ');

function receiver(options: {
  pulls: Array<Record<string, unknown>>;
  hasRule?: boolean;
  check?: string;
  existing?: string;
  mergedBefore?: string;
  failRemove?: boolean;
  dirty?: boolean;
  branch?: string;
  target?: string;
  cwd?: string;
  createRefusal?: string;
  rule?: { code: number; stderr: string };
  diff?: string;
  carrier?: string;
  proofExit?: number;
}) {
  let time = 0;
  const calls: string[] = [];
  const dirs: string[] = [];
  const pulls = [...options.pulls];
  const gh = async (a: string[]): Promise<string> => {
    calls.push(`gh ${a.join(' ')}`);
    if (a[0] === 'pr' && a[1] === 'list' && a.includes('--search'))
      return options.carrier ?? '';
    if (a[0] === 'pr' && a[1] === 'list' && a.includes('merged'))
      return options.mergedBefore ?? '';
    if (a[0] === 'pr' && a[1] === 'list') return options.existing ?? '';
    if (a[0] === 'pr' && a[1] === 'create' && options.createRefusal)
      throw new CommandFailure({
        code: 1,
        stdout: '',
        stderr: options.createRefusal,
      });
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
  const run = (command: string, a: string[], at?: string) => {
    calls.push(`${command} ${a.join(' ')}`);
    dirs.push(`${at} ${command} ${a[0]}`);
    const out = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (command === 'node') {
      assert.equal(line0(a), '--test test/rules/instruction-bytes.test.ts');
      return { code: 0, stdout: '', stderr: '', ...options.rule };
    }
    if (command === 'sh')
      return { code: options.proofExit ?? 0, stdout: '', stderr: 'proof out' };
    if (command === 'bash') return out(`commit=${merge}\n`);
    const line = a.join(' ');
    if (line === 'rev-parse --abbrev-ref HEAD')
      return out(`${options.branch ?? 'feat-x'}\n`);
    if (a[0] === 'diff') return out(options.diff ?? 'src/x.ts\n');
    if (a[0] === 'status') return out(options.dirty ? ' M f\n' : '');
    if (line === 'rev-parse HEAD') return out(`${head}\n`);
    if (line === `rev-parse origin/${options.target ?? 'main'}`)
      return out(`${base}\n`);
    if (line === 'rev-parse --show-toplevel')
      return out('/r/.krn/worktrees/feat-x\n');
    if (a.includes('--git-common-dir')) return out('/r/.git\n');
    if (options.failRemove && a[0] === 'worktree')
      return { code: 1, stdout: '', stderr: 'fatal: cannot remove' };
    if (['push', 'fetch', 'worktree', 'branch', 'ls-tree'].includes(a[0] ?? ''))
      return out('');
    assert.fail(`unexpected ${command} ${line}`);
  };
  return {
    calls,
    dirs,
    run,
    gh,
    cwd: options.cwd ?? '/r/.krn/worktrees/feat-x',
    hasFile: () => options.hasRule ?? true,
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
  // The removed worktree was the caller's cwd: name where to cd next.
  assert.match(out, /^main checkout: \/r$/mu);
  const order = [
    'push origin feat-x',
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

test('ship on a repository whose default branch is master opens the PR against master', async () => {
  const r = receiver({ pulls: [auto, merged], target: 'master' });
  const out = await shipCommand(args, { ...r, baseOf: () => 'master' });
  assert.match(out, /^verdict: merged /mu);
  const create = r.calls.find((c) => c.startsWith('gh pr create')) ?? '';
  assert.match(create, /--base master /u);
  assert.ok(r.calls.includes('git fetch -q origin master'));
  assert.ok(!r.calls.some((c) => c.includes('origin/main')));
});

test('ship --base overrides the contract base', async () => {
  const r = receiver({ pulls: [auto, merged], target: 'dev' });
  await shipCommand([...args, '--base', 'dev'], r);
  assert.ok(r.calls.some((c) => /^gh pr create .*--base dev /u.test(c)));
});

test('ship reuses the open PR of the branch instead of creating another', async () => {
  const r = receiver({ pulls: [auto, merged], existing: '7\n' });
  await shipCommand([...args, '--force'], r);
  assert.ok(
    r.calls.some((c) => c.includes('push --force-with-lease origin feat-x')),
  );
  assert.ok(!r.calls.some((c) => c.startsWith('gh pr create')));
  assert.ok(r.calls.some((c) => c.startsWith('gh pr edit 7')));
});

// Receiver capture (.krn/runs/lane-run-e2e/rerun2/stderr.txt): the retried
// create after a timed-out first attempt that had opened PR 585.
test('ship adopts the PR a timed-out create already opened', async () => {
  const r = receiver({
    pulls: [auto, merged],
    createRefusal:
      'a pull request for branch "feat-x" into branch "main" already exists:\nhttps://github.com/o/r/pull/7\n',
  });
  const out = await shipCommand(args, r);
  assert.match(out, /^pr: #7 o\/r a{40}$/mu);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
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

test('ship --worktree runs from the repository root and cleans up the named worktree', async () => {
  const r = { ...receiver({ pulls: [auto, merged] }), cwd: '/r' };
  const out = await shipCommand(
    [...args, '--worktree', '.krn/worktrees/feat-x'],
    r,
  );
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  for (const step of ['git status', 'git push'])
    assert.ok(
      r.dirs.includes(`/r/.krn/worktrees/feat-x ${step}`),
      `${step} ran outside the worktree: ${r.dirs.join('\n')}`,
    );
  assert.ok(r.calls.some((c) => c.includes('--body-file /r/body.md')));
});

test('a failing instruction-bytes rule refuses the push with its message', async () => {
  const message = 'instruction bytes grew: AGENTS.md 10 > 5';
  const r = receiver({
    pulls: [auto],
    rule: { code: 1, stderr: message },
  });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 65);
    assert.match(e.message, /instruction-bytes\.test\.ts failed/u);
    assert.ok(e.message.includes(message));
    return true;
  });
  assert.ok(r.calls.some((c) => c.startsWith('node --test')));
  assert.ok(!r.calls.some((c) => c.includes('push')));
});

test('a fetch that hits a ref lock is retried, a real fetch failure is not', async () => {
  const locked = receiver({ pulls: [auto, merged] });
  const inner = locked.run;
  let tries = 0;
  const out = await shipCommand(args, {
    ...locked,
    run: (command: string, a: string[], at?: string) => {
      if (command === 'git' && a[0] === 'fetch' && tries++ < 2)
        return {
          code: 1,
          stdout: '',
          stderr: "error: cannot lock ref 'refs/remotes/origin/main'",
        };
      return inner(command, a, at);
    },
  });
  assert.equal(tries, 3);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));

  const broken = receiver({ pulls: [auto, merged] });
  const innerBroken = broken.run;
  let attempts = 0;
  await assert.rejects(
    shipCommand(args, {
      ...broken,
      run: (command: string, a: string[], at?: string) => {
        if (command === 'git' && a[0] === 'fetch') {
          attempts++;
          return { code: 128, stdout: '', stderr: 'fatal: no such remote' };
        }
        return innerBroken(command, a, at);
      },
    }),
    CommandFailure,
  );
  assert.equal(attempts, 1);
});

test('exit 0 means merged: each unmerged verdict exits with its own code and keeps the worktree', async () => {
  const cases: Array<[Record<string, unknown>[], number, RegExp]> = [
    [[{ auto_merge: null }], 78, /^verdict: not merging/mu],
    [
      [auto, { state: 'closed', merged: false, auto_merge: null }],
      79,
      /^verdict: closed unmerged PR #7$/mu,
    ],
  ];
  for (const [pulls, code, verdict] of cases) {
    const r = receiver({ pulls });
    await assert.rejects(shipCommand(args, r), (e: Failure) => {
      assert.equal(e.exitCode, code);
      assert.match(e.message, verdict);
      assert.match(e.message, /^pr: #7 o\/r a{40}$/mu);
      return true;
    });
    assert.ok(!r.calls.some((c) => c.includes('worktree remove')));
  }
  const blocked = receiver({ pulls: [auto] });
  let elapsed = 0;
  await assert.rejects(
    shipCommand([...args], {
      ...blocked,
      now: () => (elapsed += 1_000_000),
    }),
    (e: Failure) => {
      assert.equal(e.exitCode, 80);
      assert.match(e.message, /^verdict: open: /mu);
      return true;
    },
  );
});

test('a rerun after the PR merged only cleans up and pushes nothing', async () => {
  const r = receiver({ pulls: [auto], mergedBefore: `7 ${merge}\n` });
  const out = await shipCommand(args, r);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.match(out, /^cleanup: removed worktree /mu);
  assert.ok(r.calls.some((c) => c.includes('branch -D feat-x')));
  for (const step of ['push', 'pr create', 'pr merge', 'node --test'])
    assert.ok(!r.calls.some((c) => c.includes(step)), step);
  const lookup = r.calls.find((c) => c.includes('--state merged')) ?? '';
  assert.ok(lookup.includes(`headRefOid == "${head}"`), lookup);
});

test('a refused worktree removal after the merge is a warning, not a failed ship', async () => {
  const r = receiver({ pulls: [auto, merged], failRemove: true });
  const out = await shipCommand(args, r);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.match(out, /^warning: cleanup failed \(.*cannot remove/mu);
});

test('a refused push exits 70 and names the --force rerun after a rebase', async () => {
  const r = receiver({ pulls: [auto] });
  const inner = r.run;
  const run = (command: string, a: string[], at?: string) =>
    command === 'git' && a[0] === 'push'
      ? { code: 1, stdout: '', stderr: 'rejected: non-fast-forward' }
      : inner(command, a, at);
  await assert.rejects(shipCommand(args, { ...r, run }), (e: Failure) => {
    assert.equal(e.exitCode, 70);
    assert.match(e.message, /push failed: rejected: non-fast-forward/u);
    assert.match(e.message, /rerun with --force/u);
    return true;
  });
  assert.ok(!r.calls.some((c) => c.startsWith('gh pr create')));
});

test('a push refused for a workflow file names the App permission, not a rebase', async () => {
  // Verbatim stderr of the krn-works/krn-pilot-py adoption push with the App token.
  const refused = [
    'To https://github.com/krn-works/krn-pilot-py.git',
    ' ! [remote rejected] krn-adopt -> krn-adopt (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)',
    "error: failed to push some refs to 'https://github.com/krn-works/krn-pilot-py.git'",
  ].join('\n');
  const r = receiver({ pulls: [auto] });
  const inner = r.run;
  const run = (command: string, a: string[], at?: string) =>
    command === 'git' && a[0] === 'push'
      ? { code: 1, stdout: '', stderr: refused }
      : inner(command, a, at);
  await assert.rejects(shipCommand(args, { ...r, run }), (e: Failure) => {
    assert.equal(e.exitCode, 70);
    assert.match(e.message, /Workflows \(write\) permission/u);
    assert.match(e.message, /workflow scope/u);
    assert.doesNotMatch(e.message, /rebase/u);
    return true;
  });
});

test('an empty diff against the base refuses the push and names the PR that carries the change', async () => {
  const r = receiver({ pulls: [auto, merged], diff: '', carrier: '642\n' });
  await assert.rejects(shipCommand(args, r), (error: Failure) => {
    assert.equal(error.exitCode, 66);
    assert.match(error.message, /diff against origin\/main is empty/u);
    assert.match(error.message, /PR #642 already carries/u);
    return true;
  });
  assert.ok(!r.calls.some((c) => c.startsWith('git push')));
  assert.ok(!r.calls.some((c) => c.includes('gh pr create')));
});

test('an empty diff with no matching merged PR still refuses', async () => {
  const r = receiver({ pulls: [auto, merged], diff: '' });
  await assert.rejects(shipCommand(args, r), (error: Failure) => {
    assert.equal(error.exitCode, 66);
    assert.doesNotMatch(error.message, /already carries/u);
    return true;
  });
});

test('an adopted repository without the instruction-bytes rule ships without running it', async () => {
  const r = receiver({ pulls: [auto, merged], hasRule: false });
  await shipCommand(args, r);
  assert.ok(!r.calls.some((c) => c.startsWith('node --test')));
  assert.ok(r.calls.some((c) => c.includes('push')));
});

test('ship runs the task Proof commands, records command and exit in the PR body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-proof-'));
  const file = join(dir, 'body.md');
  writeFileSync(file, '## Problem\n\nx\n');
  const r = receiver({ pulls: [auto, merged] });
  let published = '';
  const out = await shipCommand(
    ['--title', title, '--body-file', file, '--repo', 'o/r'],
    {
      ...r,
      proofOf: () => ['node --test test/x.test.ts'],
      publish: (_cwd, text) => {
        published = text;
        return '/r/published.md';
      },
    },
  );
  assert.match(out, /^verdict: merged /mu);
  assert.ok(r.calls.includes('sh -c node --test test/x.test.ts'));
  assert.match(published, /^## Problem/mu);
  assert.match(published, /^- `node --test test\/x\.test\.ts`: exit 0$/mu);
  assert.ok(
    r.calls.some((c) => c.includes('--body-file /r/published.md')),
    'the PR is created from the augmented body',
  );
});

for (const force of [false, true]) {
  test(`ship refuses with exit 81 before the push when a Proof command fails (force=${force})`, async () => {
    const r = receiver({ pulls: [auto, merged], proofExit: 3 });
    await assert.rejects(
      shipCommand([...args, ...(force ? ['--force'] : [])], {
        ...r,
        proofOf: () => ['npm run fast'],
      }),
      (error: Failure) => {
        assert.equal(error.exitCode, 81);
        assert.match(error.message, /Proof command `npm run fast` exited 3/u);
        return true;
      },
    );
    assert.equal(
      r.calls.some((c) => c.startsWith('push')),
      false,
    );
  });
}

test('ship refuses with exit 82 before the push when the base branch deploys without an acknowledgement', async () => {
  const r = receiver({ pulls: [auto, merged] });
  await assert.rejects(
    shipCommand(args, {
      ...r,
      deployRefusal: () =>
        '.github/workflows/deploy.yml deploys on a push to main; set "deploy": "acknowledged" in krn.json',
    }),
    (error: Failure) => {
      assert.equal(error.exitCode, 82);
      assert.match(
        error.message,
        /refused auto-merge: .*"deploy": "acknowledged"/u,
      );
      return true;
    },
  );
  assert.equal(
    r.calls.some((c) => c.startsWith('push') || c.includes('auto')),
    false,
  );
});
