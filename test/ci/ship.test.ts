import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ownsProductRelease, shipCommand } from '../../src/ci/ship.ts';
import { CommandFailure, run } from '../../src/deliver/transport.ts';
import { capture } from '../receivers/capture.ts';

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
  dirty?: boolean;
  branch?: string;
  target?: string;
  cwd?: string;
  createRefusal?: string;
  rule?: { code: number; stderr: string };
  diff?: string;
  carrier?: string;
  proofExit?: number;
  lateConflict?: string;
  autoRefusal?: string;
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
    if (
      a[0] === 'pr' &&
      a[1] === 'merge' &&
      a.includes('--auto') &&
      options.autoRefusal
    )
      throw new CommandFailure({
        code: 1,
        stdout: '',
        stderr: options.autoRefusal,
      });
    if (a[0] === 'pr' && a[1] !== 'view') return '';
    if (a[0] === 'pr' && a[1] === 'view') {
      const next = pulls.length > 1 ? pulls.shift() : pulls[0];
      return JSON.stringify({
        headRefOid: head,
        mergeable: 'MERGEABLE',
        autoMergeRequest: null,
        statusCheckRollup: [
          {
            name: 'Check',
            status: 'COMPLETED',
            conclusion: (options.check ?? 'success').toUpperCase(),
            detailsUrl: 'https://github.com/o/r/actions/runs/9/job/1',
          },
        ],
        ...next,
      });
    }
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
    if (command === 'env')
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
    if (a[0] === 'merge-tree') {
      // The pre-push trial merges clean; the trial after the PR turned dirty conflicts, shaped
      // like git merge-tree --write-tree --name-only: exit 1, tree id, paths, blank line.
      const conflict = options.lateConflict;
      if (
        conflict === undefined ||
        calls.filter((c) => c.includes('merge-tree')).length < 2
      )
        return out('');
      return {
        code: 1,
        stdout: `${'d'.repeat(40)}\n${conflict}\n\nAuto-merging ${conflict}\n`,
        stderr: '',
      };
    }
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
const auto = { autoMergeRequest: { mergeMethod: 'SQUASH' }, state: 'OPEN' };
const merged = { state: 'MERGED', mergeCommit: { oid: merge } };

test('ship pushes, creates, auto-merges, waits through the merge and leaves the lane in place', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const out = await shipCommand(args, r);
  assert.match(out, /^pr: #7 o\/r a{40}$/mu);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.match(
    out,
    /^lane: worktree \/r\/\.krn\/worktrees\/feat-x and branch feat-x kept; /mu,
  );
  // The lane ends at the merge: the worktree and branch stay for the next lane start to prune.
  assert.match(out, /^main checkout: \/r$/mu);
  const order = [
    'push origin feat-x',
    'gh pr list',
    'gh pr create',
    'gh pr merge 7 --repo o/r --auto --squash',
  ];
  let at = -1;
  for (const step of order) {
    const found = r.calls.findIndex((c, i) => i > at && c.includes(step));
    assert.ok(found > at, `${step} out of order in ${r.calls.join('\n')}`);
    at = found;
  }
  assert.ok(r.calls.some((c) => c.includes(`--title ${title}`)));
  assert.ok(!r.calls.some((c) => c.includes('worktree remove')));
  assert.ok(!r.calls.some((c) => c.includes('branch -D')));
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
  const r = receiver({ pulls: [{ ...auto, mergeable: 'CONFLICTING' }] });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 76);
    return true;
  });
  assert.ok(!r.calls.some((c) => c.includes('worktree remove')));
});

test('a PR that turns conflicting in a source file still exits 76', async () => {
  const r = receiver({
    pulls: [{ ...auto, mergeable: 'CONFLICTING' }],
    lateConflict: 'src/a.ts',
  });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 76);
    return true;
  });
  assert.ok(!r.calls.some((c) => c.includes('--force-with-lease')));
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
    [[{ state: 'OPEN' }], 78, /^verdict: not merging/mu],
    [[auto, { state: 'CLOSED' }], 79, /^verdict: closed unmerged PR #7$/mu],
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

test('a rerun after the PR merged only records it and pushes nothing', async () => {
  const r = receiver({ pulls: [auto], mergedBefore: `7 ${merge}\n` });
  const out = await shipCommand(args, r);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.match(out, /^lane: worktree .* kept; /mu);
  assert.ok(!r.calls.some((c) => c.includes('branch -D')));
  for (const step of ['push', 'pr create', 'pr merge', 'node --test'])
    assert.ok(!r.calls.some((c) => c.includes(step)), step);
  const lookup = r.calls.find((c) => c.includes('--state merged')) ?? '';
  assert.ok(lookup.includes(`headRefOid == "${head}"`), lookup);
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
  const r = receiver({
    pulls: [auto],
    diff: '.github/workflows/ci.yml\nsrc/a.ts\n',
  });
  const inner = r.run;
  const run = (command: string, a: string[], at?: string) =>
    command === 'git' && a[0] === 'push'
      ? { code: 1, stdout: '', stderr: refused }
      : inner(command, a, at);
  await assert.rejects(shipCommand(args, { ...r, run }), (e: Failure) => {
    assert.equal(e.exitCode, 83);
    assert.match(e.message, /the operator owns this grant/u);
    assert.match(
      e.message,
      /token lacks workflows write for \.github\/workflows\/ci\.yml(?!,)/u,
    );
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
  assert.ok(
    r.calls.includes(
      'env PR_BODY=## Problem\n\nx\n sh -c node --test test/x.test.ts',
    ),
  );
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
    const file = join(mkdtempSync(join(tmpdir(), 'ship-proof-')), 'body.md');
    writeFileSync(file, '## Problem\n\nx\n');
    const withBody = ['--title', title, '--body-file', file, '--repo', 'o/r'];
    await assert.rejects(
      shipCommand([...withBody, ...(force ? ['--force'] : [])], {
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

function flaky(
  r: ReturnType<typeof receiver>,
  match: (a: string[]) => boolean,
  replies: string[],
) {
  const queue = [...replies];
  return {
    ...r,
    gh: async (a: string[]) => {
      if (match(a) && queue.length > 0) {
        r.calls.push(`gh ${a.join(' ')}`);
        return queue.shift() as string;
      }
      return r.gh(a);
    },
  };
}
const isPull = (a: string[]) => a[0] === 'pr' && a[1] === 'view';

test('ship retries an empty pull reply once and then merges', async () => {
  const r = flaky(receiver({ pulls: [auto, merged] }), isPull, ['']);
  const out = await shipCommand(args, r);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
});

test('ship with an empty gh pull reply twice exits 71 naming the command, never 74', async () => {
  const r = flaky(receiver({ pulls: [auto] }), isPull, ['', '']);
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 71);
    assert.match(e.message, /empty reply to `gh pr view 7 --repo o\/r/u);
    return true;
  });
});

test('ship with a truncated gh pull reply twice exits 71', async () => {
  const r = flaky(receiver({ pulls: [auto] }), isPull, ['{"head":', '{"he']);
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 71);
    assert.match(e.message, /truncated reply/u);
    return true;
  });
});

test('ship with an empty gh pr create reply exits 71 without a second create', async () => {
  const r = flaky(
    receiver({ pulls: [auto] }),
    (a) => a[0] === 'pr' && a[1] === 'create',
    [''],
  );
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 71);
    assert.match(e.message, /gh pr create/u);
    return true;
  });
  assert.equal(r.calls.filter((c) => c.startsWith('gh pr create')).length, 1);
});

// KRN-12: the Proof command is the real weak-tests script over a real git commit that drops
// an assertion; only the fake gh and the ship-side git stay fakes.
for (const declared of [true, false]) {
  test(`a Proof check reads the PR body as CI does (Weakens-tests line ${declared ? 'present: merges' : 'absent: exit 81'})`, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ship-weakens-'));
    const sh = (command: string) => {
      const result = run('sh', ['-c', command], repo);
      assert.equal(result.code, 0, result.stderr);
    };
    sh('git init -q && git config user.name t && git config user.email t@t');
    sh('mkdir -p src test && echo "export const a = 1;" > src/a.ts');
    sh(
      "printf 'assert.equal(1, 1);\\nassert.equal(2, 2);\\n' > test/a.test.ts && git add -A && git commit -qm base",
    );
    sh(
      "printf 'assert.equal(1, 1);\\n' > test/a.test.ts && git commit -qam weaken",
    );
    const file = join(repo, 'body.md');
    writeFileSync(
      file,
      `## Problem\n\nx\n${declared ? '\nWeakens-tests: the dropped assertion duplicated the first\n' : ''}`,
    );
    const r = receiver({ pulls: [auto, merged] });
    const proof = `node ${join(process.cwd(), 'scripts/weak-tests.mjs')} HEAD~1 HEAD`;
    const shipped = shipCommand(
      ['--title', title, '--body-file', file, '--repo', 'o/r'],
      {
        ...r,
        run: (command, a, at, input, timeoutMs) =>
          command === 'env'
            ? run(command, a, repo, input, timeoutMs)
            : r.run(command, a, at),
        proofOf: () => [proof],
        publish: () => '/r/published.md',
      },
    );
    if (declared) assert.match(await shipped, /^verdict: merged /mu);
    else
      await assert.rejects(shipped, (e: Failure) => {
        assert.equal(e.exitCode, 81);
        assert.match(e.message, /weak-tests/u);
        return true;
      });
  });
}

test('a base without a required check merges the clean PR directly when auto-merge is refused', async () => {
  const r = receiver({
    pulls: [merged],
    autoRefusal:
      'GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)',
  });
  const out = await shipCommand(args, r);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.ok(r.calls.includes('gh pr merge 7 --repo o/r --squash'));
});

test('a base with no branch protection rule merges the PR directly when auto-merge is refused', async () => {
  const r = receiver({
    pulls: [merged],
    autoRefusal:
      'GraphQL: Pull request Protected branch rules not configured for this branch (enablePullRequestAutoMerge)',
  });
  const out = await shipCommand(args, r);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.ok(r.calls.includes('gh pr merge 7 --repo o/r --squash'));
});

test('clause 5 and clause 8: a repository that disallows auto-merge gets a direct merge (verbatim 1115i refusal)', async () => {
  const r = receiver({
    pulls: [merged],
    autoRefusal:
      'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)',
  });
  const out = await shipCommand(args, r);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.ok(r.calls.includes('gh pr merge 7 --repo o/r --squash'));
});

test('any other auto-merge refusal still fails the ship', async () => {
  const r = receiver({ pulls: [merged], autoRefusal: 'GraphQL: not allowed' });
  await assert.rejects(shipCommand(args, r), /not allowed/u);
  assert.ok(!r.calls.includes('gh pr merge 7 --repo o/r --squash'));
});

// The checkout that owns the release script: the receiver's fake toplevel is this repository.
const ownCheckout =
  (inner: ReturnType<typeof receiver>['run']) =>
  (command: string, a: string[], at?: string) =>
    command === 'git' && a.join(' ') === 'rev-parse --show-toplevel'
      ? { code: 0, stdout: `${process.cwd()}\n`, stderr: '' }
      : inner(command, a, at);

test('a merge in the KRN checkout refreshes the pinned Product entry once and prints its lines', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const out = await shipCommand(args, { ...r, run: ownCheckout(r.run) });
  assert.match(out, new RegExp(`^release: commit=${merge}$`, 'mu'));
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.equal(r.calls.filter((c) => c.startsWith('bash ')).length, 1);
});

test('a failed refresh after the merge still ships merged, with a warning', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const inner = ownCheckout(r.run);
  const out = await shipCommand(args, {
    ...r,
    run: (command: string, a: string[], at?: string) =>
      command === 'bash'
        ? { code: 78, stdout: '', stderr: 'kept previous\n' }
        : inner(command, a, at),
  });
  assert.match(
    out,
    /^warning: release refresh failed \(exit 78\).*kept previous/mu,
  );
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
});

test('an adopted repository merges without running the KRN release script', () => {
  const pilot = mkdtempSync(join(tmpdir(), 'krn-adopted-'));
  mkdirSync(join(pilot, '.git'));
  mkdirSync(join(pilot, 'packages', 'seo'), { recursive: true });
  assert.equal(ownsProductRelease(join(pilot, 'packages', 'seo')), false);
  assert.equal(ownsProductRelease(process.cwd()), true);
});

test('a red Check names its run, the logs command and the rerun, and exits 74', async () => {
  const r = receiver({ pulls: [auto], check: 'failure' });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 74);
    assert.match(
      e.message,
      /Check concluded failure on a{40} in run 9; logs: bin\/krn ci logs --run 9; rerun: gh run rerun 9 --failed/u,
    );
    return true;
  });
});

test('a pending Check exits 75 at the bound and a Check that never starts exits 69 at the start bound', async () => {
  const pending = receiver({
    pulls: [
      {
        ...auto,
        statusCheckRollup: [{ name: 'Check', status: 'IN_PROGRESS' }],
      },
    ],
  });
  await assert.rejects(shipCommand(args, pending), (e: Failure) => {
    assert.equal(e.exitCode, 75);
    return true;
  });
  const absent = receiver({ pulls: [{ ...auto, statusCheckRollup: [] }] });
  await assert.rejects(shipCommand(args, absent), (e: Failure) => {
    assert.equal(e.exitCode, 69);
    return true;
  });
  assert.ok(absent.calls.filter((c) => c.startsWith('gh pr view')).length < 40);
});

test('a head that moved while the PR waited exits 77', async () => {
  const r = receiver({ pulls: [{ ...auto, headRefOid: 'e'.repeat(40) }] });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 77);
    return true;
  });
});

test('the captured rollup of a plain-gh PR reads as a successful aggregate Check and waits for the merge', async () => {
  // Verbatim `gh pr view --json headRefOid,statusCheckRollup` of PR 1112; state and autoMergeRequest are the PR's own.
  const real = JSON.parse(
    capture('fixtures/gh', 'pr-1112-head-rollup').streams.stdout?.toString(
      'utf8',
    ) ?? '',
  ) as { headRefOid: string };
  const r = receiver({ pulls: [{ ...real, ...auto }, merged] });
  const inner = r.run;
  const out = await shipCommand(args, {
    ...r,
    run: (command: string, a: string[], at?: string) =>
      command === 'git' && a.join(' ') === 'rev-parse HEAD'
        ? { code: 0, stdout: `${real.headRefOid}\n`, stderr: '' }
        : inner(command, a, at),
  });
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
});
