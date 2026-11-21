import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  closeExposure,
  completeCloseExposure,
} from '../../src/brain/close-exposure.ts';
import { EXPOSURES_FILE } from '../../src/brain/exposures.ts';
import * as baseRed from '../../src/ci/base-red.ts';
import { CommandFailure, run } from '../../src/ci/command.ts';
import {
  ownsProductRelease,
  proofEnvironment,
  shipCommand,
} from '../../src/ci/ship.ts';
import { renderPrBody } from '../../src/cli/pr-body.ts';
import { capture } from '../receivers/capture.ts';

// KRN-12: the fake git and gh answer only the exact calls ship may make, with
// output shaped like the real tools (gh pr create prints the PR url).
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const merge = 'c'.repeat(40);
const newHead = 'e'.repeat(40);
const title = 'feat(ci): ship a PR in one call (t-3ag9eqn)';
const weakensBody =
  '## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-3ag9eqn\n\nWeakens-tests: test/x.test.ts drops a dead assertion\n';
const bodyFile = join(mkdtempSync(join(tmpdir(), 'ship-body-')), 'body.md');
writeFileSync(bodyFile, weakensBody);
const args = ['--title', title, '--body-file', bodyFile, '--repo', 'o/r'];
type Failure = Error & { exitCode?: number };

const line0 = (a: string[]) => a.join(' ');

function receiver(options: {
  pulls: Array<Record<string, unknown>>;
  hasRule?: boolean;
  check?: string;
  existing?: string;
  mergedBefore?: string;
  /** The JSON answer to the lookup of every merged PR of the branch, whatever its head. */
  mergedOfBranch?: string;
  /** Merge commits `git merge-base --is-ancestor <sha> origin/<base>` reports off the base. */
  offBase?: string[];
  dirty?: boolean;
  branch?: string;
  /** The main checkout (/r): its branch, a dirty tree and a refused fast-forward. */
  main?: { branch: string; dirty?: boolean; ffExit?: number };
  target?: string;
  cwd?: string;
  createRefusal?: string;
  rule?: { code: number; stderr: string };
  scoped?: { code: number; stdout: string };
  /** The scoped check's answers run by run (the last repeats), overriding `scoped`. */
  scopedRuns?: Array<{ code: number; stdout: string }>;
  /** The porcelain status after the scoped checks ran (Biome rewrote files). */
  rewritten?: string;
  diff?: string;
  carrier?: string;
  proofExit?: number;
  lateConflict?: string;
  mergeRefusal?: string;
  common?: string;
  /** Fetches after which origin/<base> is ahead of the head: each moves the base once, the rebase catches up. */
  baseMoves?: number;
  rebaseExit?: number;
  /** The files the base changed since the branch point (`git diff --name-only HEAD...origin/<base>`). */
  baseDiff?: string;
  /** The `gh run list --commit` statuses of the head, per ask; the last one repeats. */
  runs?: string[][];
  runList?: string;
  /** `gh run list --commit` answers per ask, the last repeating; wins over `runs`. */
  runLists?: string[];
  /** The origin URL `git remote get-url origin` prints; none exits 2. */
  origin?: string;
  /** The check-runs answers of the head, per ask (the last repeats), instead of rows derived from the rollup. */
  checkRuns?: string[];
}) {
  let time = 0;
  let scopedCalls = 0;
  let behind = options.baseMoves ?? 0;
  let rebased = 0;
  const calls: string[] = [];
  const dirs: string[] = [];
  const pulls = [...options.pulls];
  let lastView: { statusCheckRollup?: unknown[] | null } = {};
  const runs = [...(options.runs ?? [[]])];
  const checkRuns = [...(options.checkRuns ?? [])];
  const answer = (a: string[]): string => {
    calls.push(`gh ${a.join(' ')}`);
    if (a[0] === 'run' && a[1] === 'list') {
      if (options.runList !== undefined) return options.runList;
      if (options.runLists !== undefined) {
        const listed = [...options.runLists];
        const next = options.runLists.length > 1 ? 1 : 0;
        const answer = listed[0] ?? '[]';
        options.runLists.splice(0, next);
        return answer;
      }
      const next = runs.length > 1 ? runs.shift() : runs[0];
      return JSON.stringify((next ?? []).map((status) => ({ status })));
    }
    if (a[0] === 'api' && /\/commits\/[^/]+\/check-runs/u.test(a[1] ?? '')) {
      if (checkRuns.length > 0)
        return (checkRuns.length > 1 ? checkRuns.shift() : checkRuns[0]) ?? '';
      // The check-runs answer of the PR view just served: a rollup entry is a run of the required App unless it names another.
      const rollup = (lastView.statusCheckRollup ?? []) as object[];
      return JSON.stringify(rollup.map((run) => ({ appId: 15368, ...run })));
    }
    if (a[0] === 'pr' && a[1] === 'list' && a.includes('--search'))
      return options.carrier ?? '';
    if (a[0] === 'pr' && a[1] === 'list' && a.includes('merged'))
      return a.some((part) => part.includes('headRefOid =='))
        ? (options.mergedBefore ?? '')
        : (options.mergedOfBranch ?? '[]');
    if (a[0] === 'pr' && a[1] === 'list') return options.existing ?? '';
    if (a[0] === 'pr' && a[1] === 'create' && options.createRefusal)
      throw new CommandFailure({
        code: 1,
        stdout: '',
        stderr: options.createRefusal,
      });
    if (a[0] === 'pr' && a[1] === 'create')
      return 'https://github.com/o/r/pull/7\n';
    if (a[0] === 'pr' && a[1] === 'merge' && options.mergeRefusal)
      throw new CommandFailure({
        code: 1,
        stdout: '',
        stderr: options.mergeRefusal,
      });
    if (a[0] === 'pr' && a[1] !== 'view') return '';
    if (a[0] === 'pr' && a[1] === 'view') {
      const next = pulls.length > 1 ? pulls.shift() : pulls[0];
      lastView = {
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
      } as typeof lastView;
      return JSON.stringify(lastView);
    }
    assert.fail(`unexpected gh call ${a.join(' ')}`);
  };
  const gh = async (a: string[]): Promise<string> => answer(a);
  const run = (command: string, a: string[], at?: string) => {
    calls.push(`${command} ${a.join(' ')}`);
    dirs.push(`${at} ${command} ${a[0]}`);
    const out = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    const fast = a.indexOf('scripts/fast-check.ts');
    if (command === 'env' && fast > 0 && a[fast - 1] === 'node') {
      assert.equal(
        line0(a.slice(fast)),
        `scripts/fast-check.ts --base origin/${options.target ?? 'main'}`,
      );
      assert.ok(a[0]?.startsWith('PR_BODY='), 'the scoped check gets PR_BODY');
      scopedCalls += 1;
      const answer = options.scopedRuns
        ? options.scopedRuns[
            Math.min(scopedCalls, options.scopedRuns.length) - 1
          ]
        : options.scoped;
      return { code: 0, stderr: '', stdout: '', ...answer };
    }
    if (command === 'node') {
      assert.equal(line0(a), '--test test/rules/instruction-bytes.test.ts');
      return { code: 0, stdout: '', stderr: '', ...options.rule };
    }
    if (command === 'env')
      return { code: options.proofExit ?? 0, stdout: '', stderr: 'proof out' };
    if (command === 'bash') return out(`commit=${merge}\n`);
    const line = a.join(' ');
    if (at === '/r' && options.main) {
      if (line === 'rev-parse --abbrev-ref HEAD')
        return out(`${options.main.branch}\n`);
      if (a[0] === 'status') return out(options.main.dirty ? ' M f\n' : '');
      if (a[0] === 'merge')
        return {
          code: options.main.ffExit ?? 0,
          stdout: '',
          stderr: 'fatal: Not possible to fast-forward, aborting.\n',
        };
    }
    if (line === 'rev-parse --abbrev-ref HEAD')
      return out(`${options.branch ?? 'feat-x'}\n`);
    if (a[0] === 'diff' && a[2]?.startsWith('HEAD...'))
      return out(options.baseDiff ?? 'src/x.ts\n');
    if (a[0] === 'diff') return out(options.diff ?? 'src/x.ts\n');
    // The review reads its numstat with unquoted paths (`git -c core.quotePath=false diff`).
    if (a[0] === '-c' && a[2] === 'diff')
      return out(options.diff ?? 'src/x.ts\n');
    if (a[0] === 'status') {
      const afterScoped = calls.some((call) =>
        call.includes('node scripts/fast'),
      );
      const committed = calls.some((call) => call.startsWith('git commit'));
      if (afterScoped && options.rewritten && !committed)
        return out(options.rewritten);
      return out(options.dirty ? ' M f\n' : '');
    }
    if (line === 'rev-parse HEAD^{tree}') return out(`${'7'.repeat(40)}\n`);
    if (line === 'rev-parse HEAD')
      return out(`${rebased > 0 ? newHead : head}\n`);
    if (line === `rev-parse origin/${options.target ?? 'main'}`)
      return out(`${base}\n`);
    if (line === 'rev-parse --show-toplevel')
      return out('/r/.krn/worktrees/feat-x\n');
    if (a.includes('--git-common-dir'))
      return out(`${options.common ?? '/r'}/.git\n`);
    if (a[0] === 'merge-base' && options.offBase?.includes(a[2] ?? ''))
      return { code: 1, stdout: '', stderr: '' };
    if (a[0] === 'merge-base') {
      // git merge-base --is-ancestor exits 1 while the head lacks the base tip.
      if (behind > 0) {
        behind -= 1;
        return { code: 1, stdout: '', stderr: '' };
      }
      return out('');
    }
    if (a[0] === 'rebase' && a[1] === '--abort') return out('');
    if (a[0] === 'rebase') {
      rebased += 1;
      return {
        code: options.rebaseExit ?? 0,
        stdout: '',
        stderr: 'CONFLICT\n',
      };
    }
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
    if (line === 'remote get-url origin')
      return options.origin === undefined
        ? { code: 2, stdout: '', stderr: 'error: No such remote' }
        : out(`${options.origin}\n`);
    if (
      [
        'push',
        'fetch',
        'worktree',
        'branch',
        'ls-tree',
        'show-ref',
        'add',
        'commit',
      ].includes(a[0] ?? '')
    )
      return out('');
    assert.fail(`unexpected ${command} ${line}`);
  };
  return {
    calls,
    dirs,
    run,
    gh,
    answer,
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

test('ship without --repo names the repository from the origin URL, never through gh repo view', async () => {
  // gh repo view ran on the default App token, which cannot see a private outside repository: the pilot lane
  // t-h2yjgx3 failed with "Could not resolve to a Repository with the name 'krn-works/seo-audit-harness'" (2026-11-17).
  const r = receiver({
    pulls: [auto, merged],
    origin: 'https://github.com/krn-works/seo-audit-harness.git',
  });
  const out = await shipCommand(['--title', title, '--body-file', bodyFile], r);
  assert.match(out, /^pr: #7 krn-works\/seo-audit-harness a{40}$/mu);
  assert.ok(!r.calls.some((c) => c.startsWith('gh repo view')));
});

test('ship --drop pushes, creates, merges explicitly, waits through the merge and removes the lane no process works in', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const out = await shipCommand([...args, '--drop'], {
    ...r,
    completeClose: completeCloseExposure,
  });
  assert.match(out, /^pr: #7 o\/r a{40}$/mu);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.match(
    out,
    /^lane: worktree \/r\/\.krn\/worktrees\/feat-x and branch feat-x removed$/mu,
  );
  assert.match(out, /^main checkout: \/r$/mu);
  const order = [
    'push origin feat-x',
    'gh pr list',
    'gh pr create',
    `gh pr merge 7 --repo o/r --squash --match-head-commit ${head}`,
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

test('a merged ship --drop keeps the lane while another process works inside it, and a ship without --drop keeps it', async () => {
  const plain = receiver({ pulls: [auto, merged] });
  const kept = await shipCommand(args, { ...plain, worktreeUsers: () => [] });
  assert.match(
    kept,
    /^lane: worktree \/r\/\.krn\/worktrees\/feat-x and branch feat-x kept \(no --drop\); the next krn lane start prunes merged lanes$/mu,
  );
  assert.ok(!plain.calls.some((c) => c.includes('worktree remove')));
  const r = receiver({ pulls: [auto, merged] });
  const asked: string[] = [];
  const out = await shipCommand([...args, '--drop'], {
    ...r,
    worktreeUsers: (path) => {
      asked.push(path);
      return [4242];
    },
  });
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.deepEqual(asked, ['/r/.krn/worktrees/feat-x']);
  assert.match(
    out,
    /^lane: worktree \/r\/\.krn\/worktrees\/feat-x and branch feat-x kept \(process 4242 still works inside it\); the next krn lane start prunes merged lanes$/mu,
  );
  assert.ok(!r.calls.some((c) => c.includes('worktree remove')));
  assert.ok(!r.calls.some((c) => c.includes('branch -D')));
});

test('a merged ship fast-forwards a clean main checkout on the base, and only that one', async () => {
  const ff = 'git merge --ff-only -q origin/main';
  const clean = receiver({ pulls: [auto, merged], main: { branch: 'main' } });
  const out = await shipCommand(args, {
    ...clean,
    completeClose: completeCloseExposure,
  });
  assert.match(out, /^main sync: fast-forwarded to origin\/main$/mu);
  assert.ok(clean.dirs.includes('/r git merge'), clean.dirs.join('\n'));
  assert.ok(clean.calls.includes(ff));
  const dirty = receiver({
    pulls: [auto, merged],
    main: { branch: 'main', dirty: true },
  });
  assert.match(
    await shipCommand(args, { ...dirty, completeClose: completeCloseExposure }),
    /^main sync: skipped, the main checkout has uncommitted changes$/mu,
  );
  assert.ok(!dirty.calls.includes(ff));
  const elsewhere = receiver({
    pulls: [auto, merged],
    main: { branch: 'topic' },
  });
  assert.match(
    await shipCommand(args, {
      ...elsewhere,
      completeClose: completeCloseExposure,
    }),
    /^main sync: skipped, the main checkout is not on main$/mu,
  );
  assert.ok(!elsewhere.calls.includes(ff));
  // A diverged main checkout warns; the merged PR still exits as merged.
  const diverged = receiver({
    pulls: [auto, merged],
    main: { branch: 'main', ffExit: 128 },
  });
  const warned = await shipCommand(args, {
    ...diverged,
    completeClose: completeCloseExposure,
  });
  assert.match(warned, /^verdict: merged /mu);
  assert.match(
    warned,
    /^main sync: warning, not fast-forwarded: fatal: Not possible to fast-forward, aborting\.$/mu,
  );
});

test('a merged ship completes the pending close row of its task with the PR and the Check conclusion, once', async () => {
  const main = mkdtempSync(join(tmpdir(), 'ship-close-row-'));
  const log = join(main, EXPOSURES_FILE);
  mkdirSync(join(main, '.krn', 'brain'), { recursive: true });
  closeExposure(main, {
    task: 't-3ag9eqn',
    clauses: ['r-a'],
    pr: null,
    ci: null,
    hidden: null,
  });
  const r = receiver({ pulls: [auto, merged], common: main });
  await shipCommand(args, { ...r, completeClose: completeCloseExposure });
  const rows = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0] ?? '').evidence, {
    pr: 7,
    ci: 'success',
    hidden: null,
  });
  await shipCommand(args, {
    ...receiver({ pulls: [auto, merged], common: main }),
    completeClose: completeCloseExposure,
  });
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
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
  // The adopted PR is carried to its merge, pinned to the head ship pushed.
  assert.ok(
    r.calls.some((c) =>
      c.startsWith(`gh pr merge 7 --repo o/r --squash --match-head-commit`),
    ),
  );
});

test('a near-empty body is refused with exit 65 naming every missing part, before any git or gh call', async () => {
  const empty = join(mkdtempSync(join(tmpdir(), 'ship-empty-')), 'body.md');
  writeFileSync(
    empty,
    '\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n',
  );
  const r = receiver({ pulls: [auto, merged] });
  await assert.rejects(
    shipCommand(['--title', title, '--body-file', empty, '--repo', 'o/r'], r),
    (e: Failure) => {
      assert.equal(e.exitCode, 65);
      assert.match(e.message, /"## Why"/u);
      assert.match(e.message, /"## Verified"/u);
      assert.match(e.message, /Ticket.*Refs/u);
      return true;
    },
  );
  assert.equal(r.calls.length, 0, r.calls.join('\n'));
});

test('a body written by krn pr body is accepted by ship', async () => {
  const written = join(mkdtempSync(join(tmpdir(), 'ship-written-')), 'b.md');
  writeFileSync(
    written,
    renderPrBody({
      task: {
        id: 't-3ag9eqn' as never,
        status: 'open',
        resolution: null,
        created: '2026-11-19',
        priority: 3,
        title: 'Ship',
        after: [],
        body: ['Outcome: ship.\nWhy: one call.'],
      },
      commits: ['feat(ci): ship a PR in one call (t-3ag9eqn)'],
      verified: 'npm run fast: PASS',
      agent: 'A',
      refs: false,
    }),
  );
  const r = receiver({ pulls: [auto, merged] });
  const out = await shipCommand(
    ['--title', title, '--body-file', written, '--repo', 'o/r'],
    r,
  );
  assert.match(out, /^verdict: merged /mu);
  assert.ok(r.calls.some((c) => c.includes('push')));
});

test('a tracker-less repository ships a body without a Ticket or Refs line', async () => {
  const plain = join(mkdtempSync(join(tmpdir(), 'ship-plain-')), 'b.md');
  writeFileSync(plain, '## Why\n\nx\n\n## Verified\n\ny\n');
  const r = receiver({ pulls: [auto, merged] });
  const out = await shipCommand(
    ['--title', title, '--body-file', plain, '--repo', 'o/r'],
    { ...r, tracked: () => false },
  );
  assert.match(out, /^verdict: merged /mu);
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
  // The relative body.md resolves against /r, which does not exist: a reused fast PASS keeps
  // the scoped check (which reads the body for PR_BODY) out of this case.
  const out = await shipCommand(
    [
      '--title',
      title,
      '--body-file',
      'body.md',
      '--repo',
      'o/r',
      '--worktree',
      '.krn/worktrees/feat-x',
    ],
    { ...r, fastPass: () => '7'.repeat(40), readBody: () => weakensBody },
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
  assert.equal(tries, 4);
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

test('a merged ship asks the tracker to release the claim of its task, and a failing release never fails the ship', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const asked: string[] = [];
  const out = await shipCommand(args, {
    ...r,
    releaseClaim: (main, worktree, task) => {
      asked.push(`${main} ${worktree} ${task}`);
      throw new Error('claim store unreadable');
    },
  });
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.deepEqual(asked, ['/r /r/.krn/worktrees/feat-x t-3ag9eqn']);
});

test('a ship that stops unmerged releases no claim', async () => {
  const r = receiver({ pulls: [auto], check: 'failure' });
  const asked: string[] = [];
  await assert.rejects(
    shipCommand(args, {
      ...r,
      releaseClaim: (_m, _w, task) => asked.push(task),
    }),
  );
  assert.deepEqual(asked, []);
});

test('a rerun after the PR merged only records it and pushes nothing', async () => {
  const r = receiver({ pulls: [auto], mergedBefore: `7 ${merge}\n` });
  const out = await shipCommand(args, {
    ...r,
    completeClose: completeCloseExposure,
  });
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.match(out, /^lane: worktree .* kept \(no --drop\); /mu);
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

const headTree = '7'.repeat(40);

async function shipCapturingStdout(
  r: ReturnType<typeof receiver>,
  fastPass: string | undefined,
): Promise<string> {
  const write = process.stdout.write;
  let printed = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await shipCommand(args, {
      ...r,
      fastPass: () => fastPass,
      completeClose: completeCloseExposure,
    });
  } catch (error) {
    printed += `${(error as Error).message}\n`;
  } finally {
    process.stdout.write = write;
  }
  return printed;
}

test('a fast PASS record for the HEAD tree skips the scoped check and pushes', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const printed = await shipCapturingStdout(r, headTree);
  assert.match(
    printed,
    new RegExp(`^pre-push: fast PASS reused for tree ${headTree}$`, 'mu'),
  );
  assert.ok(!r.calls.some((c) => c.includes('node scripts/fast-check.ts')));
  assert.ok(r.calls.some((c) => c.includes('git push')));
});

test('a fast PASS record for another tree runs the scoped check', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const printed = await shipCapturingStdout(r, 'b'.repeat(40));
  assert.doesNotMatch(printed, /fast PASS reused/u);
  assert.ok(r.calls.some((c) => c.includes('node scripts/fast-check.ts')));
});

test('the scoped check runs with the PR body as PR_BODY, as the Proof commands do', async () => {
  const r = receiver({ pulls: [auto, merged] });
  await shipCapturingStdout(r, undefined);
  assert.ok(
    r.calls.some(
      (c) =>
        c.startsWith(`env PR_BODY=${weakensBody} `) &&
        c.includes(' node scripts/fast-check.ts --base origin/main'),
    ),
    'a declared Weakens-tests line reaches weak-tests inside the scoped check',
  );
  assert.ok(r.calls.some((c) => c.includes('git push')));
});

test('a dirty worktree never reuses a fast PASS record', async () => {
  const r = receiver({ pulls: [auto, merged], dirty: true });
  const printed = await shipCapturingStdout(r, headTree);
  assert.doesNotMatch(printed, /fast PASS reused/u);
  assert.ok(!r.calls.some((c) => c.includes('git push')));
});

test('a failing scoped check refuses the push with exit 65 and records no push call', async () => {
  const r = receiver({
    pulls: [auto],
    scoped: { code: 1, stdout: '--- biome ---\nspec/receivers.json format' },
  });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 65);
    assert.match(e.message, /scoped checks .* failed/u);
    assert.ok(e.message.includes('spec/receivers.json format'));
    return true;
  });
  assert.ok(r.calls.some((c) => c.includes('node scripts/fast-check.ts')));
  assert.ok(!r.calls.some((c) => c.includes('git push')));
});

const timedOut = (file: string) =>
  ` FAIL  ${file} > slow\nError: Test timed out in 60000ms.\n`;

test('a scoped check that times out on different tests in a run and its rerun exits 78', async () => {
  const r = receiver({
    pulls: [auto],
    scopedRuns: [
      { code: 1, stdout: timedOut('test/evals/a.test.ts') },
      { code: 1, stdout: timedOut('test/evals/b.test.ts') },
    ],
  });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 78);
    assert.match(e.message, /host load/u);
    return true;
  });
  assert.ok(!r.calls.some((c) => c.includes('git push')));
});

test('a scoped check that times out and passes on the rerun ships; an assertion failure stays 65', async () => {
  const flaky = receiver({
    pulls: [auto, merged],
    scopedRuns: [
      { code: 1, stdout: timedOut('test/a.test.ts') },
      { code: 0, stdout: '' },
    ],
  });
  await shipCommand(args, flaky);
  assert.ok(flaky.calls.some((c) => c.includes('git push')));
  const red = receiver({
    pulls: [auto],
    scopedRuns: [
      {
        code: 1,
        stdout:
          ' FAIL  test/a.test.ts > x\nAssertionError: expected 1 to be 2\n',
      },
    ],
  });
  await assert.rejects(shipCommand(args, red), (e: Failure) => {
    assert.equal(e.exitCode, 65);
    return true;
  });
});

test('a format-only rewrite of tracked files is committed by ship and the push goes on', async () => {
  const r = receiver({ pulls: [auto, merged], rewritten: ' M src/x.ts\n' });
  await shipCommand(args, { ...r, completeClose: completeCloseExposure });
  const commit = r.calls.findIndex((c) => c.startsWith('git commit'));
  assert.ok(commit >= 0, 'the rewrite is committed');
  assert.ok(r.calls.some((c) => c.startsWith('git add -u')));
  assert.ok(
    r.calls.findIndex((c) => c.includes('git push')) > commit,
    'the commit precedes the push',
  );
});

test('a scoped check that left an untracked file refuses the push', async () => {
  const r = receiver({ pulls: [auto], rewritten: '?? src/new.ts\n' });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 65);
    assert.match(e.message, /rewrote files/u);
    return true;
  });
  assert.ok(!r.calls.some((c) => c.includes('git push')));
});

test('the local check runs only the scoped check, never the full suite', async () => {
  const r = receiver({ pulls: [auto, merged] });
  await shipCommand(args, { ...r, completeClose: completeCloseExposure });
  assert.ok(r.calls.some((c) => c.includes('node scripts/fast-check.ts')));
  assert.ok(
    !r.calls.some((c) => /npm (run )?test|node --test \S+\/$/u.test(c)),
  );
  assert.ok(
    r.calls
      .filter((c) => c.startsWith('node '))
      .every(
        (c) =>
          c.startsWith('node --test test/rules/instruction-bytes') ||
          c.includes('scripts/fast-check.ts'),
      ),
  );
});

test('an adopted repository without the instruction-bytes rule ships without running it', async () => {
  const r = receiver({ pulls: [auto, merged], hasRule: false });
  await shipCommand(args, { ...r, completeClose: completeCloseExposure });
  assert.ok(!r.calls.some((c) => c.startsWith('node ')));
  assert.ok(r.calls.some((c) => c.includes('push')));
});

test('ship runs the task Proof commands, records command and exit in the PR body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-proof-'));
  const file = join(dir, 'body.md');
  writeFileSync(file, '## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-3ag9eqn\n');
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
    r.calls.some(
      (c) =>
        c.startsWith(
          'env PR_BODY=## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-3ag9eqn\n ',
        ) && c.endsWith(' sh -c node --test test/x.test.ts'),
    ),
  );
  assert.match(published, /^## Why/mu);
  assert.match(published, /^- `node --test test\/x\.test\.ts`: exit 0$/mu);
  assert.ok(
    r.calls.some((c) => c.includes('--body-file /r/published.md')),
    'the PR is created from the augmented body',
  );
});

for (const [diff, refused] of [
  ['tasks/t-abc.json\ntasks/t-def.json\n', false],
  ['tasks/t-abc.json\nsrc/x.ts\n', true],
] as const) {
  test(`a Proof naming a missing command ${refused ? 'still refuses a diff that touches code' : 'never refuses a task-records-only diff'} with exit 81`, async () => {
    const r = receiver({ pulls: [auto, merged], proofExit: 127, diff });
    const file = join(mkdtempSync(join(tmpdir(), 'ship-records-')), 'body.md');
    writeFileSync(
      file,
      '## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-3ag9eqn\n',
    );
    const shipped = shipCommand(
      ['--title', title, '--body-file', file, '--repo', 'o/r'],
      { ...r, proofOf: () => ['krn skills check'], publish: () => '/r/p.md' },
    );
    if (refused)
      await assert.rejects(shipped, (e: Failure) => e.exitCode === 81);
    else {
      // A refusal is asserted as a value, so the base source fails this test by assertion.
      const outcome = await shipped.then(
        (out) => out,
        (e: Failure) => `refused ${e.exitCode}`,
      );
      assert.match(outcome, /^verdict: merged /mu);
      assert.equal(
        r.calls.some((c) => c.endsWith(' sh -c krn skills check')),
        false,
        'the Proof never ran',
      );
    }
  });
}

for (const force of [false, true]) {
  test(`ship refuses with exit 81 before the push when a Proof command fails (force=${force})`, async () => {
    const r = receiver({ pulls: [auto, merged], proofExit: 3 });
    const file = join(mkdtempSync(join(tmpdir(), 'ship-proof-')), 'body.md');
    writeFileSync(
      file,
      '## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-3ag9eqn\n',
    );
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

// KRN-12: the refusal text is the verbatim stderr of `gh api repos/krn-works/krn/pulls/999999`.
test('a gh refusal reaches the caller with the receiver stderr, without a retry', async () => {
  const stderr =
    capture('fixtures/gh', 'pr-not-found').streams.stderr?.toString('utf8') ??
    '';
  const { gh: _fake, ...r } = receiver({ pulls: [auto] });
  let asked = 0;
  await assert.rejects(
    shipCommand(['--title', title, '--body-file', 'body.md'], {
      ...r,
      readBody: () => weakensBody,
      run: (command: string, a: string[], at?: string) => {
        if (command !== 'gh') return r.run(command, a, at);
        asked++;
        return { code: 1, stdout: '', stderr };
      },
    }),
    (e: Error) => {
      assert.equal(e.message, stderr);
      return true;
    },
  );
  assert.equal(asked, 1);
});

// KRN-12: the TLS stderr is the verbatim text a ship lane printed when its gh call lost the network.
const tlsTimeout =
  capture('fixtures/gh', 'pr-view-tls-timeout').streams.stderr?.toString(
    'utf8',
  ) ?? '';

/** Routes the default gh through the fake: `pr view` fails with `stderr` for the first `times` asks. */
function flakyView(
  r: ReturnType<typeof receiver>,
  failure: { times: number; stderr: string },
) {
  const { gh: _fake, ...rest } = r;
  const asked: string[] = [];
  const route = (command: string, given: string[], at?: string) => {
    // A call that names --repo runs as `env KRN_APP_REPOSITORY=<repo> gh ...`.
    const scoped = command === 'env' && given[1] === 'gh';
    const a = scoped ? given.slice(2) : given;
    if (command !== 'gh' && !scoped) return r.run(command, a, at);
    if (a[0] === 'pr' && a[1] === 'view') {
      asked.push(a.join(' '));
      if (asked.length <= failure.times)
        return { code: 1, stdout: '', stderr: failure.stderr };
    }
    return { code: 0, stdout: r.answer(a), stderr: '' };
  };
  return { rest: { ...rest, run: route }, asked };
}

test('ship retries gh pr view after a TLS handshake timeout and merges', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const { rest, asked } = flakyView(r, { times: 2, stderr: tlsTimeout });
  const out = await shipCommand(args, rest);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.ok(asked.length >= 3);
});

// KRN-12: verbatim stderr of gh failing to connect; the lead's ship exited 70 on it twice.
test('ship retries gh pr view after gh cannot connect to the API and merges', async () => {
  const stderr =
    capture('fixtures/gh', 'gh-error-connecting').streams.stderr?.toString(
      'utf8',
    ) ?? '';
  assert.match(stderr, /^error connecting to api\.github\.com$/mu);
  const r = receiver({ pulls: [auto, merged] });
  const { rest, asked } = flakyView(r, { times: 2, stderr });
  const out = await shipCommand(args, rest);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.ok(asked.length >= 3);
});

// A message no allowlist has seen: it carries no HTTP status, so GitHub never answered it.
const unseenNetworkFailure =
  'Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 10.0.0.1:3128: connect: no route to host';

test('ship retries a gh pr view that fails four times with an unseen network message and merges', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const { rest, asked } = flakyView(r, {
    times: 4,
    stderr: unseenNetworkFailure,
  });
  const out = await shipCommand(args, rest);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.ok(asked.length >= 5);
});

test('after the push ship gives up on an unanswered gh call only once five minutes of backoff are spent', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const { rest, asked } = flakyView(r, { times: 99, stderr: tlsTimeout });
  await assert.rejects(shipCommand(args, rest), (e: Error) => {
    assert.equal(e.message, tlsTimeout);
    return true;
  });
  assert.ok(asked.length > 3, `${asked.length} asks`);
  assert.ok(r.now() >= 300_000, `${r.now()} ms waited`);
  assert.ok(r.now() < 360_000, `${r.now()} ms waited`);
});

test('before the push an unanswered gh call is tried three times', async () => {
  const r = receiver({ pulls: [auto] });
  const { gh: _fake, ...rest } = r;
  let asked = 0;
  await assert.rejects(
    shipCommand(['--title', title, '--body-file', 'body.md'], {
      ...rest,
      readBody: () => weakensBody,
      run: (command: string, a: string[], at?: string) => {
        if (command !== 'gh') return r.run(command, a, at);
        asked++;
        return { code: 1, stdout: '', stderr: unseenNetworkFailure };
      },
    }),
    (e: Error) => {
      assert.equal(e.message, unseenNetworkFailure);
      return true;
    },
  );
  assert.equal(asked, 3);
  assert.ok(!r.calls.some((c) => c.startsWith('git push')));
});

test('a pr create whose reply was lost adopts the PR it created instead of creating another', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const { gh: _fake, ...rest } = r;
  let creates = 0;
  const route = (command: string, given: string[], at?: string) => {
    const scoped = command === 'env' && given[1] === 'gh';
    const a = scoped ? given.slice(2) : given;
    if (command !== 'gh' && !scoped) return r.run(command, a, at);
    if (a[0] === 'pr' && a[1] === 'create') {
      creates++;
      return { code: 1, stdout: '', stderr: tlsTimeout };
    }
    // The open PR appears only after the create that lost its reply.
    if (a[0] === 'pr' && a[1] === 'list' && a.includes('open'))
      return { code: 0, stdout: creates === 0 ? '' : '7\n', stderr: '' };
    return { code: 0, stdout: r.answer(a), stderr: '' };
  };
  const out = await shipCommand(args, { ...rest, run: route });
  assert.match(out, /^pr: #7 /mu);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.equal(creates, 1);
});

test('a rerun on a rebased branch whose PR already merged reports the merge and exits 0', async () => {
  const r = receiver({
    pulls: [merged],
    diff: '',
    mergedOfBranch: JSON.stringify([
      { number: 7, title, body: '', mergeCommit: { oid: merge } },
    ]),
  });
  const out = await shipCommand(args, r);
  assert.match(out, /^pr: #7 /mu);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  for (const step of ['git push', 'pr create', 'pr merge'])
    assert.ok(!r.calls.some((c) => c.includes(step)), step);
});

test('a rerun whose branch name an older merged PR of another task reused refuses the empty diff', async () => {
  // KRN-12: the real merged PRs of a lane slug two other tasks used before this one.
  const reused =
    capture(
      'fixtures/gh',
      'pr-list-merged-reused-branch',
    ).streams.stdout?.toString('utf8') ?? '';
  const r = receiver({ pulls: [merged], diff: '', mergedOfBranch: reused });
  await assert.rejects(shipCommand(args, r), (error: Failure) => {
    assert.equal(error.exitCode, 66);
    return true;
  });
  assert.ok(!r.calls.some((c) => c.includes('pr merge')));
});

test('a merged PR of the task whose merge is not on the base is not reported as merged', async () => {
  const r = receiver({
    pulls: [merged],
    diff: '',
    mergedOfBranch: JSON.stringify([
      { number: 7, title, body: '', mergeCommit: { oid: merge } },
    ]),
    offBase: [merge],
  });
  await assert.rejects(shipCommand(args, r), (error: Failure) => {
    assert.equal(error.exitCode, 66);
    return true;
  });
});

test('ship does not retry a gh pr view that answers 404', async () => {
  const stderr =
    capture('fixtures/gh', 'pr-not-found').streams.stderr?.toString('utf8') ??
    '';
  const r = receiver({ pulls: [auto, merged] });
  const { rest, asked } = flakyView(r, {
    times: 99,
    stderr,
  });
  await assert.rejects(shipCommand(args, rest), (e: Error) => {
    assert.equal(e.message, stderr);
    return true;
  });
  assert.equal(asked.length, 1);
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
      `## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-3ag9eqn\n${declared ? '\nWeakens-tests: the dropped assertion duplicated the first\n' : ''}`,
    );
    const r = receiver({ pulls: [auto, merged] });
    const proof = `node ${join(process.cwd(), 'scripts/weak-tests.mjs')} HEAD~1 HEAD`;
    const shipped = shipCommand(
      ['--title', title, '--body-file', file, '--repo', 'o/r'],
      {
        ...r,
        run: (command, a, at, input, timeoutMs) =>
          command === 'env' && !a.includes('scripts/fast-check.ts')
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

test('a base that moved after the Check passed is merged only after the update and a fresh green Check', async () => {
  const stale = { ...auto };
  const fresh = { ...auto, headRefOid: newHead };
  const r = receiver({
    // The PR keeps its old head and old green Check for one poll after the push.
    pulls: [stale, stale, fresh, { ...merged, headRefOid: newHead }],
    baseMoves: 1,
  });
  const out = await shipCommand(args, r);
  assert.match(
    out,
    new RegExp(`^updated: origin/main moved; .*${newHead}$`, 'mu'),
  );
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  const order = [
    'push origin feat-x',
    'git rebase origin/main',
    'git push --force-with-lease origin feat-x',
    `gh pr merge 7 --repo o/r --squash --match-head-commit ${newHead}`,
  ];
  let at = -1;
  for (const step of order) {
    const found = r.calls.findIndex((c, i) => i > at && c.includes(step));
    assert.ok(found > at, `${step} out of order in ${r.calls.join('\n')}`);
    at = found;
  }
  // The stale head is never merged, and exactly one merge is requested.
  const merges = r.calls.filter((c) => c.startsWith('gh pr merge'));
  assert.equal(merges.length, 1);
  assert.ok(!merges[0]?.includes(head));
});

test('a base that moved on a disjoint file merges the checked head without a rebase or force-push', async () => {
  const r = receiver({
    pulls: [auto, merged],
    baseMoves: 1,
    diff: 'src/x.ts\n',
    baseDiff: 'docs/y.md\n',
  });
  const out = await shipCommand(args, r);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.ok(!r.calls.some((c) => c.startsWith('git rebase')));
  assert.ok(!r.calls.some((c) => c.includes('--force-with-lease')));
  assert.deepEqual(
    r.calls.filter((c) => c.startsWith('gh pr merge')),
    [`gh pr merge 7 --repo o/r --squash --match-head-commit ${head}`],
  );
});

test('a base that moved on a disjoint file still rebases when GitHub does not report the PR mergeable', async () => {
  const unknown = { ...auto, mergeable: 'UNKNOWN' };
  const r = receiver({
    pulls: [
      unknown,
      unknown,
      { ...auto, headRefOid: newHead },
      { ...merged, headRefOid: newHead },
    ],
    baseMoves: 1,
    baseDiff: 'docs/y.md\n',
  });
  await shipCommand(args, r);
  assert.ok(r.calls.includes('git rebase origin/main'));
});

test('a base that moved on a file the patch touches rebases and keeps the 76 path on conflict', async () => {
  const r = receiver({
    pulls: [auto],
    baseMoves: 1,
    rebaseExit: 1,
    diff: 'src/x.ts\n',
    baseDiff: 'src/x.ts\ndocs/y.md\n',
  });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 76);
    return true;
  });
  assert.ok(r.calls.includes('git rebase origin/main'));
});

test('a base that moved and no longer rebases exits 76 without merging', async () => {
  const r = receiver({ pulls: [auto], baseMoves: 1, rebaseExit: 1 });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 76);
    return true;
  });
  assert.ok(r.calls.includes('git rebase --abort'));
  assert.ok(!r.calls.some((c) => c.startsWith('gh pr merge')));
});

test('a head that moved between the Check and the pinned merge exits 77', async () => {
  const r = receiver({
    pulls: [auto],
    mergeRefusal:
      capture('fixtures/gh', 'pr-merge-head-moved').streams.stderr?.toString(
        'utf8',
      ) ?? '',
  });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 77);
    return true;
  });
});

test('a merge GitHub reports as already in progress keeps waiting and ends merged', async () => {
  const r = receiver({
    pulls: [auto, auto, merged],
    mergeRefusal: 'GraphQL: Merge already in progress (mergePullRequest)\n',
  });
  const out = await shipCommand(args, r);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
});

test('a merge already in progress that never lands still ends open with exit 80', async () => {
  const r = receiver({
    pulls: [auto],
    mergeRefusal: 'GraphQL: Merge already in progress (mergePullRequest)\n',
  });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 80);
    return true;
  });
});

test('any other merge refusal still fails the ship', async () => {
  const r = receiver({ pulls: [auto], mergeRefusal: 'GraphQL: not allowed' });
  await assert.rejects(shipCommand(args, r), /not allowed/u);
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
      /Check concluded failure on a{40} in run 9; logs: gh run view 9 --log-failed; rerun: gh run rerun 9 --failed/u,
    );
    return true;
  });
});

// `gh api repos/krn-works/krn/commits/2b9a44f.../check-runs?filter=all&per_page=100 --jq CHECK_FACT_FILTER`
// for PR #1449 after `gh run rerun 44381299774 --failed` concluded (real output). While attempt 2 ran, its
// aggregate Check row did not exist yet and its rerun job was not completed: only those two rows are varied.
const rerunCapture = () =>
  capture(
    'fixtures/gh',
    'check-runs-1449-rerun-attempts',
  ).streams.stdout?.toString('utf8') ?? '';
type Row = { id: number; name: string; status: string; conclusion: string };
const attempt2Check = 135080025160;
const attempt2Rerun = 135079345220;
const rerunning = (vary: (rows: Row[]) => Row[]) =>
  JSON.stringify(vary(JSON.parse(rerunCapture()) as Row[]));
const unstartedAggregate = rerunning((rows) =>
  rows
    .filter((row) => row.id !== attempt2Check)
    .map((row) =>
      row.id === attempt2Rerun
        ? { ...row, status: 'IN_PROGRESS', conclusion: '' }
        : row,
    ),
);
const queuedAggregate = rerunning((rows) =>
  rows.map((row) =>
    row.id === attempt2Check
      ? { ...row, status: 'QUEUED', conclusion: '', startedAt: null }
      : row.id === attempt2Rerun
        ? { ...row, status: 'IN_PROGRESS', conclusion: '' }
        : row,
  ),
);

test('a failed Check attempt superseded by an in-progress rerun is awaited, and the rerun success merges', async () => {
  for (const pending of [unstartedAggregate, queuedAggregate]) {
    // 70 polls of 10 s: past the 600 s merge bound, so a superseded failure is never read as a concluded Check.
    const r = receiver({
      pulls: [...Array(71).fill(auto), merged],
      checkRuns: [...Array(70).fill(pending), rerunCapture()],
    });
    const out = await shipCommand(args, r);
    assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
    assert.ok(r.now() > 600_000, `${r.now()} ms waited`);
  }
});

test('a rerun attempt that fails again still exits 74 on its own run', async () => {
  const failedAgain = rerunning((rows) =>
    rows.map((row) =>
      row.id === attempt2Check ? { ...row, conclusion: 'FAILURE' } : row,
    ),
  );
  const r = receiver({
    pulls: [auto],
    checkRuns: [unstartedAggregate, failedAgain],
  });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 74);
    assert.match(
      e.message,
      /Check concluded failure on a{40} in run 44381299774/u,
    );
    return true;
  });
});

test('a cancelled Check attempt is awaited while GitHub lists a newer run of its workflow, and that run merges', async () => {
  // PR #1551 (real check-runs, see provenance): the newest aggregate row is the cancelled attempt of run 44781928074,
  // while a newer run was queued and had no job row yet, so only the run list shows it.
  // Only the rows of the newer run 44782200146 are dropped: its jobs did not exist at that moment.
  const stale = JSON.stringify(
    (
      JSON.parse(
        capture(
          'fixtures/gh',
          'check-runs-1551-newer-run',
        ).streams.stdout?.toString('utf8') ?? '',
      ) as { detailsUrl: string }[]
    ).filter((row) => !row.detailsUrl.includes('/runs/44782200146/')),
  );
  const listing = (newer: string) =>
    JSON.stringify([
      {
        databaseId: 44781928074,
        status: 'completed',
        workflowDatabaseId: 378810503,
      },
      { databaseId: 44785668602, status: newer, workflowDatabaseId: 378810503 },
      { databaseId: 44785000000, status: 'queued', workflowDatabaseId: 1 },
    ]);
  const r = receiver({
    pulls: [...Array(5).fill(auto), merged],
    checkRuns: [...Array(4).fill(stale), rerunCapture()],
    runLists: [...Array(4).fill(listing('queued')), listing('completed')],
  });
  const out = await shipCommand(args, r);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
});

test('a failed Check still exits 74 while only an unrelated workflow is unfinished on the head', async () => {
  const failed = JSON.stringify(
    (
      JSON.parse(
        capture(
          'fixtures/gh',
          'check-runs-1551-newer-run',
        ).streams.stdout?.toString('utf8') ?? '',
      ) as { detailsUrl: string }[]
    ).filter((row) => !row.detailsUrl.includes('/runs/44782200146/')),
  );
  const r = receiver({
    pulls: [auto],
    checkRuns: [failed],
    runLists: [
      JSON.stringify([
        {
          databaseId: 44781928074,
          status: 'completed',
          workflowDatabaseId: 378810503,
        },
        { databaseId: 44780000000, status: 'queued', workflowDatabaseId: 1 },
        { databaseId: 44785000000, status: 'queued', workflowDatabaseId: 1 },
      ]),
    ],
  });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 74);
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

test('a run queued past the start bound is awaited, not refused, and a Check that then starts merges', async () => {
  const none = { ...auto, statusCheckRollup: [] };
  // The rollup stays empty past 300 s while GitHub lists the run queued, then the Check concludes.
  const r = receiver({
    pulls: [...Array(40).fill(none), auto, merged],
    runs: [['queued']],
  });
  const out = await shipCommand(args, r);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.ok(r.now() > 300_000, `${r.now()} ms waited`);
  assert.ok(r.calls.some((c) => c.startsWith('gh run list')));
});

test('a run listed for the head with a not-completed status is awaited, not refused with 69', async () => {
  // `gh run list --commit 3a71b7d... --json status,databaseId,createdAt,startedAt,event,workflowName` for
  // run 44035472255 (real output); only status is varied, to the not-completed value under test.
  const none = { ...auto, statusCheckRollup: [] };
  for (const status of ['queued', 'in_progress']) {
    const listed = JSON.parse(
      capture(
        'fixtures/gh',
        'run-list-head-completed',
      ).streams.stdout?.toString('utf8') ?? '',
    ).map((run: object) => ({ ...run, status }));
    const r = receiver({
      pulls: [...Array(40).fill(none), auto, merged],
      runList: JSON.stringify(listed),
    });
    const out = await shipCommand(args, r);
    assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  }
});

test('a head that moved while the PR waited exits 77', async () => {
  const r = receiver({ pulls: [{ ...auto, headRefOid: 'e'.repeat(40) }] });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 77);
    return true;
  });
});

test('a PR merged at another head than the shipped one exits 77 and is never reported as merged', async () => {
  const r = receiver({
    pulls: [{ ...merged, headRefOid: 'e'.repeat(40) }],
  });
  await assert.rejects(shipCommand(args, r), (e: Failure) => {
    assert.equal(e.exitCode, 77);
    assert.match(e.message, /head moved/u);
    assert.doesNotMatch(e.message, /verdict: merged/u);
    return true;
  });
});

test('a superseded failed Check run beside a newer green one for the same head merges', async () => {
  // Verbatim `gh pr view 1158 --json headRefOid,statusCheckRollup`: run 43813499494 failed first, rerun 43813694201 passed.
  const real = JSON.parse(
    capture(
      'fixtures/gh',
      'pr-1158-superseded-rollup',
    ).streams.stdout?.toString('utf8') ?? '',
  ) as { headRefOid: string };
  const r = receiver({
    pulls: [
      { ...real, ...auto },
      { ...merged, headRefOid: real.headRefOid },
    ],
  });
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

test('a cancelled older run beside a newer green one merges, a cancelled newest run says cancelled', async () => {
  const run = (conclusion: string, startedAt: string, id: number) => ({
    name: 'Check',
    status: 'COMPLETED',
    conclusion,
    startedAt,
    detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1`,
  });
  const older = run('CANCELLED', '2026-11-16T06:01:31Z', 1);
  const newer = run('SUCCESS', '2026-11-16T06:03:13Z', 2);
  for (const rollup of [
    [older, newer],
    [newer, older],
  ]) {
    const r = receiver({
      pulls: [{ ...auto, statusCheckRollup: rollup }, merged],
    });
    const out = await shipCommand(args, r);
    assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  }
  const cancelled = receiver({
    pulls: [
      {
        ...auto,
        statusCheckRollup: [
          run('SUCCESS', '2026-11-16T06:01:31Z', 1),
          run('CANCELLED', '2026-11-16T06:03:13Z', 2),
        ],
      },
    ],
  });
  await assert.rejects(shipCommand(args, cancelled), (e: Failure) => {
    assert.equal(e.exitCode, 74);
    assert.match(e.message, /^verdict: cancelled: /mu);
    assert.match(e.message, /Check concluded cancelled on a{40} in run 2/u);
    return true;
  });
});

// Regression: gh answered statusCheckRollup null right after auto-merge was enabled; ship exited 70 while the PR merged.
test('a pr view whose check rollup is null reads as no checks yet and ship waits through the merge', async () => {
  const r = receiver({ pulls: [{ ...auto, statusCheckRollup: null }, merged] });
  const out = await shipCommand(args, r);
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
});

test('the captured rollup of a plain-gh PR reads as a successful aggregate Check and waits for the merge', async () => {
  // Verbatim `gh pr view --json headRefOid,statusCheckRollup` of PR 1112; state and autoMergeRequest are the PR's own.
  const real = JSON.parse(
    capture('fixtures/gh', 'pr-1112-head-rollup').streams.stdout?.toString(
      'utf8',
    ) ?? '',
  ) as { headRefOid: string };
  const r = receiver({
    pulls: [
      { ...real, ...auto },
      { ...merged, headRefOid: real.headRefOid },
    ],
  });
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

test('a Proof command that starts with krn runs the worktree bin/krn, not the one on PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'ship-proof-krn-'));
  const worktree = join(root, 'worktree');
  const own = join(worktree, 'bin');
  const other = join(root, 'path');
  mkdirSync(own, { recursive: true });
  mkdirSync(other);
  for (const [dir, marker] of [
    [own, 'worktree-krn'],
    [other, 'path-krn'],
  ] as const) {
    writeFileSync(join(dir, 'krn'), `#!/bin/sh\necho ${marker}\n`, {
      mode: 0o755,
    });
  }
  const saved = process.env.PATH;
  process.env.PATH = `${other}:${saved}`;
  try {
    const proof = run(
      'env',
      [...proofEnvironment(worktree, ''), 'sh', '-c', 'krn ledger --limit 1'],
      worktree,
    );
    assert.equal(proof.code, 0);
    assert.equal(proof.stdout.trim(), 'worktree-krn');
    const bare = run(
      'env',
      [...proofEnvironment(other, ''), 'sh', '-c', 'krn ledger'],
      other,
    );
    assert.equal(bare.stdout.trim(), 'path-krn');
  } finally {
    process.env.PATH = saved;
  }
});

test('a same-named Check of another App never lets ship merge, and a skipped or neutral aggregate stops it', async () => {
  const check = (conclusion: string, appId?: number) => ({
    name: 'Check',
    status: 'COMPLETED',
    conclusion,
    ...(appId === undefined ? {} : { appId }),
  });
  // A foreign green Check is not the required one: with no required run the Check never started (69).
  const foreign = receiver({
    pulls: [{ ...auto, statusCheckRollup: [check('SUCCESS', 99)] }],
  });
  await assert.rejects(shipCommand(args, foreign), (e: Failure) => {
    assert.equal(e.exitCode, 69);
    return true;
  });
  // A foreign green Check beside a required red one: the red one speaks.
  const red = receiver({
    pulls: [
      {
        ...auto,
        statusCheckRollup: [
          { ...check('FAILURE'), startedAt: '2026-11-16T06:01:00Z' },
          { ...check('SUCCESS', 99), startedAt: '2026-11-16T06:09:00Z' },
        ],
      },
    ],
  });
  await assert.rejects(shipCommand(args, red), (e: Failure) => {
    assert.equal(e.exitCode, 74);
    return true;
  });
  for (const conclusion of ['SKIPPED', 'NEUTRAL']) {
    const r = receiver({
      pulls: [{ ...auto, statusCheckRollup: [check(conclusion)] }],
    });
    await assert.rejects(shipCommand(args, r), (e: Failure) => {
      assert.equal(e.exitCode, 74);
      assert.match(
        e.message,
        new RegExp(`concluded ${conclusion.toLowerCase()}`, 'u'),
      );
      return true;
    });
  }
});

// KRN-12: the base-red gate runs against a real git repository and the real node test runner.
const gitIn = (dir: string, ...gitArgs: string[]) => {
  const result = spawnSync('git', gitArgs, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

/** A repository whose base commit has a buggy src/area.ts and whose `fix` branch carries `testSource` and `fixed`. */
function defectRepository(
  testSource: string,
  fixed: string,
  buggy = 'export const side = () => 1;\n',
): string {
  const dir = mkdtempSync(join(tmpdir(), 'ship-base-red-'));
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'config', 'user.email', 'a@b.c');
  gitIn(dir, 'config', 'user.name', 'a');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src', 'area.ts'), buggy);
  writeFileSync(join(dir, 'README.md'), 'x\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'base');
  gitIn(dir, 'checkout', '-q', '-b', 'fix');
  writeFileSync(join(dir, 'src', 'area.ts'), fixed);
  writeFileSync(join(dir, 'test', 'area.test.ts'), testSource);
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'fix');
  return dir;
}

const sideFixed = 'export const side = () => 2;\n';
const sideTest = (expected: number) =>
  `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { side } from '../src/area.ts';\ntest('side is ${expected}', () => {\n  assert.equal(side(), ${expected});\n});\n`;
const shipDefect = (dir: string, kind: string | undefined) => {
  const file = join(mkdtempSync(join(tmpdir(), 'ship-body-')), 'body.md');
  writeFileSync(file, '## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-3ag9eqn\n');
  const r = receiver({ pulls: [auto, merged], cwd: dir });
  let published = '';
  return {
    r,
    published: () => published,
    ship: () =>
      shipCommand(['--title', title, '--body-file', file, '--repo', 'o/r'], {
        ...r,
        kindOf: () => kind,
        baseRed: (at, ref, _runner, env) =>
          baseRed.baseRedProof(at, ref.replace('origin/', ''), run, env),
        publish: (_cwd, text) => {
          published = text;
          return '/r/published.md';
        },
      }),
  };
};

test('a defect branch whose new test also passes on the base source is refused with exit 81', async () => {
  const dir = defectRepository(sideTest(1), sideFixed);
  const { r, ship } = shipDefect(dir, 'defect');
  await assert.rejects(ship(), (error: Failure) => {
    assert.equal(error.exitCode, 81);
    assert.match(
      error.message,
      /test\/area\.test\.ts passes on the base source/u,
    );
    return true;
  });
  assert.equal(
    r.calls.some((c) => c.startsWith('push')),
    false,
  );
  assert.equal(gitIn(dir, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(dir, 'src', 'area.ts'), 'utf8'), sideFixed);
});

test('a defect branch whose test fails on the base by assertion ships and records the case names', async () => {
  const dir = defectRepository(sideTest(2), sideFixed);
  const { published, ship } = shipDefect(dir, 'defect');
  assert.match(await ship(), /^verdict: merged /mu);
  assert.match(published(), /^## Base red proof$/mu);
  assert.match(published(), /^- fails on the base source: side is 2$/mu);
  assert.equal(gitIn(dir, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(dir, 'src', 'area.ts'), 'utf8'), sideFixed);
});

test('a base run that fails only by a missing module is refused, and the tree is restored', async () => {
  const dir = defectRepository(
    `import test from 'node:test';\nimport { gone } from '../src/gone.ts';\ntest('x', () => gone());\n`,
    sideFixed,
  );
  const { ship } = shipDefect(dir, 'defect');
  await assert.rejects(ship(), (error: Failure) => {
    assert.equal(error.exitCode, 81);
    assert.match(error.message, /without an assertion/u);
    assert.match(error.message, /ERR_MODULE_NOT_FOUND/u);
    return true;
  });
  assert.equal(gitIn(dir, 'status', '--porcelain'), '');
});

test('a base run that fails by a syntax error in the base source is not red', () => {
  const dir = defectRepository(
    sideTest(2),
    sideFixed,
    'export const side = ;\n',
  );
  const verdict = baseRed.baseRedProof(dir, 'main', run);
  assert.equal(verdict.kind, 'load-error');
  assert.equal(gitIn(dir, 'status', '--porcelain'), '');
});

test('a defect branch without a changed test is refused, and a non-defect task is not run on the base', async () => {
  const dir = defectRepository(sideTest(1), sideFixed);
  gitIn(dir, 'rm', '-q', 'test/area.test.ts');
  gitIn(dir, 'commit', '-q', '-m', 'drop test');
  const { ship } = shipDefect(dir, 'defect');
  await assert.rejects(ship(), (error: Failure) => {
    assert.equal(error.exitCode, 81);
    assert.match(error.message, /needs a changed or added test file/u);
    return true;
  });
  const green = defectRepository(sideTest(1), sideFixed);
  assert.match(await shipDefect(green, 'gate').ship(), /^verdict: merged /mu);
});

// KRN-12: a Python receiver runs the real python3 unittest runner through ship's entry.
const pythonFixed = 'def side():\n    return 2\n';

/** A Python repository whose base has a buggy app.py and whose `fix` branch carries tests/test_app.py and `fixed`. */
function pythonRepository(testSource: string, fixed: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ship-base-red-py-'));
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'config', 'user.email', 'a@b.c');
  gitIn(dir, 'config', 'user.name', 'a');
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'app.py'), 'def side():\n    return 1\n');
  writeFileSync(join(dir, '.gitignore'), '__pycache__/\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'base');
  gitIn(dir, 'checkout', '-q', '-b', 'fix');
  writeFileSync(join(dir, 'app.py'), fixed);
  writeFileSync(join(dir, 'tests', 'test_app.py'), testSource);
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'fix');
  return dir;
}
const sideCase = (expected: number) =>
  `import unittest\n\nfrom app import side\n\n\nclass SideTest(unittest.TestCase):\n    def test_side_is_${expected}(self):\n        self.assertEqual(side(), ${expected})\n`;

test('a Python defect fix whose test fails by assertion on the base ships and records the case', {}, async () => {
  const dir = pythonRepository(sideCase(2), pythonFixed);
  const { published, ship } = shipDefect(dir, 'defect');
  assert.match(await ship(), /^verdict: merged /mu);
  assert.match(published(), /^## Base red proof$/mu);
  assert.match(published(), /^- fails on the base source: .*test_side_is_2$/mu);
  assert.equal(gitIn(dir, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(dir, 'app.py'), 'utf8'), pythonFixed);
});

test('a Python test that passes on the base is refused as green', {}, async () => {
  const dir = pythonRepository(sideCase(1), pythonFixed);
  const { ship } = shipDefect(dir, 'defect');
  await assert.rejects(ship(), (error: Failure) => {
    assert.equal(error.exitCode, 81);
    assert.match(
      error.message,
      /tests\/test_app\.py passes on the base source/u,
    );
    return true;
  });
  assert.equal(gitIn(dir, 'status', '--porcelain'), '');
});

test('a Python test that fails on the base by an import error is refused as not red', {}, async () => {
  const dir = pythonRepository(
    'import unittest\n\nfrom gone import side\n\n\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.assertEqual(side(), 2)\n',
    pythonFixed,
  );
  const { ship } = shipDefect(dir, 'defect');
  await assert.rejects(ship(), (error: Failure) => {
    assert.equal(error.exitCode, 81);
    assert.match(error.message, /without an assertion/u);
    assert.match(error.message, /ModuleNotFoundError/u);
    return true;
  });
  assert.equal(gitIn(dir, 'status', '--porcelain'), '');
});

test('pythonAssertionFailures reads unittest FAIL and pytest assertion lines, not other errors', () => {
  const output = [
    'FAIL: test_a (tests.test_app.SideTest.test_a)',
    'ERROR: test_b (tests.test_app.SideTest.test_b)',
    'FAILED tests/test_app.py::test_c - assert 1 == 2',
    'FAILED tests/test_app.py::test_d - AssertionError: nope',
    "FAILED tests/test_app.py::test_e - NameError: name 'x' is not defined",
    'ERROR tests/test_f.py',
  ].join('\n');
  assert.deepEqual(baseRed.pythonAssertionFailures(output), [
    'tests.test_app.SideTest.test_a',
    'tests/test_app.py::test_c',
    'tests/test_app.py::test_d',
  ]);
});

// KRN-12: the 502 text is the stderr shape gh prints for a gateway answer (`gh: <message> (HTTP 502)`).
for (const status of ['502', '429']) {
  test(`ship retries a gh pr view that answers HTTP ${status} while it waits and merges`, async () => {
    const r = receiver({ pulls: [auto, merged] });
    const { rest, asked } = flakyView(r, {
      times: 2,
      stderr: `gh: Server Error (HTTP ${status})\n`,
    });
    const out = await shipCommand(args, rest);
    assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
    assert.ok(asked.length >= 3);
  });
}

test('a gh pr view that keeps answering HTTP 502 stops after the retry budget with the receiver stderr', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const stderr = 'gh: Server Error (HTTP 502)\n';
  const { rest } = flakyView(r, { times: 999, stderr });
  await assert.rejects(shipCommand(args, rest), (e: Error) => {
    assert.equal(e.message, stderr);
    return true;
  });
});

test('a merged ship prints its verdict even when the cleanup after the merge throws', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const out = await shipCommand([...args, '--drop'], {
    ...r,
    worktreeUsers: () => {
      throw new Error('ps unavailable');
    },
  });
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
  assert.match(out, /^warning: ps unavailable$/mu);
  assert.ok(out.indexOf('verdict: merged') < out.indexOf('warning:'));
});

test('the task named in the title wins over KRN_TASK for the claim release', async () => {
  const r = receiver({ pulls: [auto, merged] });
  const asked: string[] = [];
  const before = process.env.KRN_TASK;
  process.env.KRN_TASK = 't-zzzzzzz';
  try {
    await shipCommand(args, {
      ...r,
      releaseClaim: (_m, _w, task) => asked.push(task),
    });
  } finally {
    if (before === undefined) delete process.env.KRN_TASK;
    else process.env.KRN_TASK = before;
  }
  assert.deepEqual(asked, ['t-3ag9eqn']);
});

test('the usage text states exits 69 and 70', async () => {
  const { shipUsage } = await import('../../src/ci/ship.ts');
  assert.match(shipUsage, /\b70 /u);
  assert.match(shipUsage, /\b69 /u);
});

/** An advisory review that answers `kind` for every head and records, per head, whether the merge call came first. */
function reviewed(kind: 'pass' | 'block' | 'silent', calls: string[]) {
  const judged: { at: string; afterMerge: boolean }[] = [];
  const startReview = () => ({
    line: 'review: tier 2, the reviewer reads origin/main...HEAD beside the Check',
    verdict: async (at: string) => {
      judged.push({
        at,
        afterMerge: calls.some((c) => c.includes('gh pr merge 7')),
      });
      return kind === 'silent'
        ? { kind, line: 'review: the reviewer exited 1' }
        : { kind, line: `review: ${kind}`, findings: [] };
    },
    dispose: () => {},
  });
  return { judged, startReview };
}

for (const kind of ['pass', 'block', 'silent'] as const)
  test(`a ${kind} review is advisory: the ship merges on the Check, then joins the review once`, async () => {
    const r = receiver({ pulls: [auto, merged] });
    const review = reviewed(kind, r.calls);
    const out = await shipCommand(args, {
      ...r,
      startReview: review.startReview,
    });
    assert.match(out, /^verdict: merged /mu);
    assert.match(
      out,
      kind === 'silent'
        ? /^review: the reviewer exited 1$/mu
        : new RegExp(`^review: ${kind}$`, 'mu'),
    );
    assert.deepEqual(review.judged, [{ at: head, afterMerge: true }]);
  });
