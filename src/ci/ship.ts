import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { removeFinishedLane } from '../repo/lane-removal.ts';
import { repositoryOfRemote } from '../repo/remote.ts';
import {
  CHECK_FACT_FILTER,
  type CheckFact,
  isGreen,
  isRequiredCheckName,
  selectRequiredCheck,
} from '../repo/required-check.ts';
import { gitLockError } from '../repo/shell-text.ts';
import { recordShip } from '../repo/ship-record.ts';
import { baseRedProof, baseRedRefusal } from './base-red.ts';
import { CommandFailure, checked, type Runner, run } from './command.ts';
import { titleProblem } from './commit-title.ts';
import { assertNoConflict } from './conflict-check.ts';
import { readFastPass } from './fast-pass.ts';
import { clearShipLive, markShipLive } from './ship-live.ts';
import { taskMerge, taskMergeFields } from './task-merge.ts';
import {
  exitHostLoadFlake,
  hostLoadFlake,
  timeoutOnly,
} from './test-failures.ts';

export const shipUsage =
  'Usage: krn pr ship --title <type(scope): outcome (t-id)> --body-file <path> [--repo <owner/repo>] [--force] [--drop] [--worktree <path>] [--base <branch>] [--detach]; --detach runs the ship as its own session with its log and pid under <worktree>/.krn/tmp (ship.log, ship.pid) so it outlives the agent that started it, and prints the pid at once (see `krn lane status`); the PR targets --base, else the repo contract base; run from the repository root with --worktree (or inside the branch worktree): pushes the branch, creates (or reuses) the PR, waits for a green Check, rebases onto the base when the base moved since (a fresh Check runs), then merges explicitly with --match-head-commit and waits through the merge, then records the merge, fast-forwards a clean main checkout that is on the base (a `main sync:` line), then, with --drop (a lead ship), removes the worktree and branch unless another process still works inside the worktree or it holds an uncommitted change (the ship process itself may run there); without --drop, or when refused, the next `krn lane start` prunes the merged lane; prints the gate, merge and `verdict:` lines; exits 0 only when the PR merged (a merged PR with a failed pinned-entry refresh still exits 0 with a warning); a rerun after the merge only records it; otherwise 65 instruction-bytes rule failed before the push, 78 the scoped checks failed with timeouts only on different tests in a run and its rerun (host load; rerun ship), 66 empty diff against the base, 74 failed gate, 81 a task Proof command exited non-zero before the push, or the changed tests of a defect task do not fail by assertion on the base source of the changed files (--force does not bypass it), 83 the push was rejected because the App token lacks the workflows permission for a .github/workflows edit (the message names the files and the remedy), 82 the repository deploys on a push to the base branch and krn.json lacks "deploy": "acknowledged" (no push, no auto-merge), 75 timeout, 76 conflict with the base, before the push or after the base moved during the wait, 77 head moved, 79 PR closed unmerged, 80 still open and blocked, 64 usage or refused title';

const releaseScript = fileURLToPath(
  new URL('../../scripts/product-release.sh', import.meta.url),
);
/**
 * True when cwd sits in a checkout of the KRN product itself: only that repository has a
 * pinned Product entry to refresh, so an adopted repository skips the release script.
 */
export function ownsProductRelease(cwd: string): boolean {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'scripts', 'product-release.sh'))) return true;
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return false;
  }
}

const ghTimeoutMs = 30_000;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Tries per gh call before the push: the first plus two retries of a failure GitHub never answered. */
const networkTries = 3;
const networkBackoffMs = 1000;
const networkBackoffCapMs = 30_000;
/** After the push a PR may exist: an unanswered gh call is retried for this long before ship gives up. */
const networkBudgetMs = 300_000;
/**
 * A gh failure GitHub answered: an HTTP status or a GraphQL error. Every other stderr (a timeout, a reset,
 * a resolver or proxy message nobody has seen yet) never reached an answer, so the call is safe to repeat.
 */
export const answeredFailure = (stderr: string) =>
  /\bHTTP [1-5]\d\d\b|\bGraphQL: |head branch was modified/iu.test(stderr);
const pollMs = 10_000;
const gateTimeoutMs = 1_800_000;
const startTimeoutMs = 300_000;
const mergeTimeoutMs = 600_000;
const prView = z.object({
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  headRefOid: z.string(),
  mergeable: z.string().optional(),
  autoMergeRequest: z.unknown().optional(),
  mergeCommit: z.object({ oid: z.string() }).nullish(),
  statusCheckRollup: z
    .array(
      z.object({
        name: z.string().optional(),
        startedAt: z.string().optional(),
        status: z.string().optional(),
        conclusion: z.string().nullish(),
        detailsUrl: z.string().optional(),
      }),
    )
    // gh answers null before any check registers on a fresh head: no checks yet.
    .nullish()
    .transform((rollup) => rollup ?? []),
});
type PrView = z.infer<typeof prView>;
/**
 * The newest aggregate Check of the head: a rerun or a superseded run leaves older runs in the
 * rollup, and only the latest one speaks for the head. Ordered by start time, later entry on a tie.
 */
export function newestCheck(
  rollup: PrView['statusCheckRollup'],
): PrView['statusCheckRollup'][number] | undefined {
  let newest: PrView['statusCheckRollup'][number] | undefined;
  for (const run of rollup) {
    if (!isRequiredCheckName(run.name)) continue;
    if (
      newest === undefined ||
      (run.startedAt ?? '') >= (newest.startedAt ?? '')
    )
      newest = run;
  }
  return newest;
}

const gitLockAttempts = 5;
/** Regenerate-and-push rounds after the PR turns conflicting while it waits. */
const workflowsRejection = /without `?workflows`? permission/u;
const instructionBytesRule = 'test/rules/instruction-bytes.test.ts';
/** The repository's own scoped check: Biome on changed files, tsc, and the tests the changed paths select. */
const scopedCheck = 'scripts/fast-check.ts';

function usageError(message: string): Error {
  return Object.assign(new Error(message), { exitCode: 64 });
}

/**
 * The environment a Proof command runs in: PR_BODY as CI sets it, and the worktree's bin/ first on
 * PATH so a leading `krn` runs the code under review, not the main checkout's.
 */
export function proofEnvironment(cwd: string, prBody: string): string[] {
  const own = join(cwd, 'bin');
  return [
    `PR_BODY=${prBody}`,
    ...(existsSync(join(own, 'krn'))
      ? [`PATH=${own}${delimiter}${process.env.PATH ?? ''}`]
      : []),
  ];
}

async function shipRun(
  args: string[],
  runtime: {
    cwd?: string;
    run?: Runner;
    gh?: (args: string[]) => Promise<string>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** The repo contract base for a worktree; the cli supplies it, the default is main. */
    baseOf?: (cwd: string) => string;
    /** Whether `path` exists under `cwd`; the default reads the file system. */
    hasFile?: (cwd: string, path: string) => boolean;
    /** The tree hash of the recorded clean fast PASS for `cwd`; the default reads the worktree's record. */
    fastPass?: (cwd: string) => string | undefined;
    /** Waits for the host load to fall below the core count before each scoped check run; the cli supplies it, the default does not wait. */
    quiet?: () => void;
    /** The remedy text when the worktree deploys on a push to `base` and krn.json does not acknowledge it, else undefined; the cli supplies it. */
    deployRefusal?: (cwd: string, base: string) => string | undefined;
    /** The runnable Proof commands of the task the title names, read from the worktree; the cli supplies it. */
    proofOf?: (cwd: string, title: string) => string[];
    /** The kind of the task the title names, read from the worktree; the cli supplies it. A `defect` ships only with a test that is red on the base source. */
    kindOf?: (cwd: string, title: string) => string | undefined;
    /** Runs the branch's tests on the base source of its changed files; the default does it in `cwd`. */
    baseRed?: typeof baseRedProof;
    /** The PR body to publish: `text` is the body file plus the proof record; the default writes it under .krn/tmp of `cwd`. */
    publish?: (cwd: string, text: string) => string;
    /** The pids of other processes working inside a path; the default reads /proc. */
    worktreeUsers?: (path: string) => number[] | undefined;
    /** Releases the claim in `main` of a task whose record in `worktree` is closed; the cli supplies the tracker's. */
    releaseClaim?: (main: string, worktree: string, task: string) => void;
    /** Completes the close evidence row of a task whose PR merged; the cli supplies the brain's writer. */
    completeClose?: (
      main: string,
      done: { task: string; pr: number; ci: string | null },
    ) => void;
  } = {},
): Promise<string> {
  let values: ReturnType<typeof parse>;
  try {
    values = parse(args);
  } catch {
    throw usageError(shipUsage);
  }
  const { title, bodyFile, force } = values;
  if (title === undefined || bodyFile === undefined)
    throw usageError(shipUsage);
  const problem = titleProblem(title);
  if (problem !== undefined) throw usageError(`refused title: ${problem}`);

  const caller = runtime.cwd ?? process.cwd();
  // Shipping from the root keeps the caller's shell in a directory that
  // survives the cleanup below.
  const cwd =
    values.worktree === undefined ? caller : resolve(caller, values.worktree);
  const body = resolve(caller, bodyFile);
  const runner = runtime.run ?? run;
  const wait = runtime.sleep ?? sleep;
  // Every GitHub call that names a repository uses an App token minted for that repository.
  const scoped: Runner = (command, a, ...rest) => {
    const named = a.indexOf('--repo');
    return command === 'gh' && named >= 0 && a[named + 1] !== undefined
      ? runner(
          'env',
          [`KRN_APP_REPOSITORY=${a[named + 1]}`, command, ...a],
          ...rest,
        )
      : runner(command, a, ...rest);
  };
  let afterPush = false;
  const gh =
    runtime.gh ??
    (async (a) => {
      // `pr create` is not idempotent: a lost reply could hide a created PR, so its caller looks first.
      const once = a[0] === 'pr' && a[1] === 'create';
      let waited = 0;
      for (let attempt = 1; ; attempt += 1) {
        const result = scoped('gh', a, cwd, undefined, ghTimeoutMs);
        if (result.code === 0) return result.stdout;
        const spent = afterPush
          ? waited >= networkBudgetMs
          : attempt >= networkTries;
        if (once || spent || answeredFailure(result.stderr))
          throw new CommandFailure(result);
        const pause = Math.min(
          networkBackoffMs * 2 ** (attempt - 1),
          networkBackoffCapMs,
        );
        await wait(pause);
        waited += pause;
      }
    });
  const git = (a: string[], at = cwd) => checked(runner('git', a, at));

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const target = values.base ?? (runtime.baseOf ?? (() => 'main'))(cwd);
  if (branch === target || branch === 'main' || branch === 'HEAD')
    throw usageError(
      `refusing to ship from "${branch}"; run inside the branch worktree`,
    );
  if (git(['status', '--porcelain']) !== '')
    throw usageError('worktree has uncommitted changes; commit them first');
  // The origin names the repository without a GitHub call: `gh repo view` would run on the default App token, which
  // cannot see a private outside repository (pilot seo-audit-harness, 2026-11-17).
  const repo =
    values.repo ??
    repositoryOfRemote(
      runner('git', ['remote', 'get-url', 'origin'], cwd).stdout ?? '',
    ) ??
    (
      await gh([
        'repo',
        'view',
        '--json',
        'nameWithOwner',
        '--jq',
        '.nameWithOwner',
      ])
    ).trim();

  const worktree = git(['rev-parse', '--show-toplevel']);
  const main = dirname(
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  // Project hooks run the main checkout's source: a clean main checkout on the base follows the merge,
  // so a lane started from the new base is never judged by an older build (a newer krn.json format).
  const syncMain = (): string => {
    const at = (a: string[]) => runner('git', a, main);
    const on = at(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (on.code !== 0 || on.stdout.trim() !== target)
      return `main sync: skipped, the main checkout is not on ${target}`;
    const dirty = at(['status', '--porcelain', '--untracked-files=no']);
    if (dirty.code !== 0 || dirty.stdout.trim() !== '')
      return 'main sync: skipped, the main checkout has uncommitted changes';
    const fetched = at(['fetch', '-q', 'origin', target]);
    const moved =
      fetched.code === 0
        ? at(['merge', '--ff-only', '-q', `origin/${target}`])
        : fetched;
    return moved.code === 0
      ? `main sync: fast-forwarded to origin/${target}`
      : `main sync: warning, not fast-forwarded: ${(moved.stderr.trim().split('\n')[0] ?? '').trim()}`;
  };
  const task =
    process.env.KRN_TASK ?? /\((t-[a-z0-9]{7})\)\s*$/u.exec(title)?.[1];
  // The lane ends here. With --drop (the lead's ship) the worktree and branch go once no other process
  // works inside them; a lane agent's ship keeps them, since its session may still run steps there
  // that no process cwd reveals, and the next `krn lane start` prunes them. The PR is merged by now:
  // a refused removal is a line, never a failed ship.
  const cleanup = (sha: string) => {
    // `head` is the lane tip that merged: a later lane that reuses the branch name never matches it.
    const head = git(['rev-parse', 'HEAD']);
    recordShip(main, {
      branch,
      sha,
      ...(head ? { head } : {}),
      ...(task ? { task } : {}),
    });
    if (task !== undefined)
      try {
        runtime.releaseClaim?.(main, worktree, task);
      } catch {
        // The PR is merged: a claim that stays is tidied by the next state check.
      }
    const synced = syncMain();
    const removal = values.drop
      ? removeFinishedLane(main, worktree, branch, {
          git: (a, at) => runner('git', a, at),
          ...(runtime.worktreeUsers ? { users: runtime.worktreeUsers } : {}),
        })
      : { removed: false as const, reason: 'no --drop' };
    return `${
      removal.removed
        ? `lane: worktree ${worktree} and branch ${branch} removed`
        : `lane: worktree ${worktree} and branch ${branch} kept (${removal.reason}); the next krn lane start prunes merged lanes`
    }
main checkout: ${main}
${synced}`;
  };
  const viewOf = (number: number) =>
    gh([
      'pr',
      'view',
      String(number),
      '--repo',
      repo,
      '--json',
      'state,headRefOid,mergeable,autoMergeRequest,mergeCommit,statusCheckRollup',
    ]).then((text) => prView.parse(JSON.parse(text)));
  // The lane closed its task before this PR existed: the merge completes the close row with the PR and its Check.
  const recordClose = (pr: number, rollup: PrView['statusCheckRollup']) => {
    if (
      task === undefined ||
      runtime.completeClose === undefined ||
      !Number.isInteger(pr)
    )
      return;
    const conclusion = newestCheck(rollup)?.conclusion;
    try {
      runtime.completeClose(main, {
        task,
        pr,
        ci: conclusion ? conclusion.toLowerCase() : null,
      });
    } catch {
      // The evidence is best effort: a merged PR never fails its ship over the log.
    }
  };
  const localHead = git(['rev-parse', 'HEAD']);
  const mergedBefore = (
    await gh([
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      branch,
      '--state',
      'merged',
      '--json',
      'number,headRefOid,mergeCommit',
      '--jq',
      `[.[] | select(.headRefOid == "${localHead}")][0] | select(. != null) | "\\(.number) \\(.mergeCommit.oid // "unknown")"`,
    ])
  ).trim();
  if (mergedBefore !== '') {
    // A rerun after the merge (its cleanup failed or was cut off) only cleans up.
    const [mergedPr, mergedSha] = mergedBefore.split(' ');
    const merged = await viewOf(Number(mergedPr)).catch(() => undefined);
    recordClose(Number(mergedPr), merged?.statusCheckRollup ?? []);
    return [
      `pr: #${mergedPr} ${repo} ${localHead}`,
      `verdict: merged ${mergedSha}`,
      cleanup(mergedSha ?? 'unknown'),
    ].join('\n');
  }

  // Parallel lanes share one object store: retry a fetch another git blocks.
  const fetchTarget = async () => {
    for (let attempt = 1; ; attempt++) {
      const fetched = runner('git', ['fetch', '-q', 'origin', target], cwd);
      if (fetched.code === 0) return;
      if (attempt >= gitLockAttempts || !gitLockError.test(fetched.stderr))
        checked(fetched);
      await wait(attempt * 1000);
    }
  };
  await fetchTarget();
  // A branch that conflicts with its base exits 76 before anything is pushed.
  assertNoConflict(cwd, target, runner);
  const changed = git(['diff', '--name-only', `origin/${target}...HEAD`]);
  if (changed === '') {
    // The task's PR merged while no ship watched (an earlier ship gave up, the branch was rebased
    // since): the rerun reports that merge instead of refusing an empty diff. Only a PR that names
    // this task and whose merge is on the base counts; a reused branch name never does.
    const mergedOfBranch = taskMerge(
      await gh([
        'pr',
        'list',
        '--repo',
        repo,
        '--head',
        branch,
        '--state',
        'merged',
        '--json',
        taskMergeFields,
      ]),
      task,
      (sha) =>
        runner(
          'git',
          ['merge-base', '--is-ancestor', sha, `origin/${target}`],
          cwd,
        ).code === 0,
    );
    if (mergedOfBranch !== undefined) {
      const { pr: mergedPr, sha: mergedSha } = mergedOfBranch;
      const merged = await viewOf(mergedPr).catch(() => undefined);
      recordClose(mergedPr, merged?.statusCheckRollup ?? []);
      return [
        `pr: #${mergedPr} ${repo} ${localHead}`,
        `verdict: merged ${mergedSha}`,
        cleanup(mergedSha),
      ].join('\n');
    }
    // An empty squash commit would merge green; name the PR that carries it.
    const carrier = (
      await gh([
        'pr',
        'list',
        '--repo',
        repo,
        '--base',
        target,
        '--state',
        'merged',
        '--search',
        `${JSON.stringify(title)} in:title`,
        '--json',
        'number,title',
        '--jq',
        `[.[] | select(.title == ${JSON.stringify(title)})][0].number // empty`,
      ])
    ).trim();
    throw Object.assign(
      new Error(
        `refused push: the diff against origin/${target} is empty${carrier === '' ? '' : `; PR #${carrier} already carries this change`}`,
      ),
      { exitCode: 66 },
    );
  }

  const deployRefusal = (runtime.deployRefusal ?? (() => undefined))(
    cwd,
    target,
  );
  if (deployRefusal !== undefined)
    throw Object.assign(new Error(`refused auto-merge: ${deployRefusal}`), {
      exitCode: 82,
    });

  // The rule is KRN's own; an adopted repository without it ships without it.
  const hasFile =
    runtime.hasFile ?? ((at, path) => existsSync(resolve(at, path)));
  const rule = hasFile(cwd, instructionBytesRule)
    ? runner('node', ['--test', instructionBytesRule], cwd)
    : { code: 0, stdout: '', stderr: '' };
  if (rule.code !== 0)
    throw Object.assign(
      new Error(
        `refused push: ${instructionBytesRule} failed\n${(rule.stderr.trim() || rule.stdout.trim()).slice(-4000)}`,
      ),
      { exitCode: 65 },
    );

  // The checks `npm run fast` scopes to the changed paths run before the push, so a rule the
  // repository already enforces fails here and not in a CI round. Biome rewrites files in
  // place; a rewrite that is not committed would never reach the push, so it refuses too.
  const tree = hasFile(cwd, scopedCheck)
    ? runner('git', ['rev-parse', 'HEAD^{tree}'], cwd).stdout.trim()
    : '';
  // PR_BODY as CI sets it: a check that reads the body (weak-tests' Weakens-tests line) sees
  // the same text before the push as on the PR, in the scoped check and in every Proof command.
  let bodyText: string | undefined;
  const prBody = (): string => {
    bodyText ??= readFileSync(body, 'utf8');
    return bodyText;
  };
  const recorded = (runtime.fastPass ?? readFastPass)(cwd);
  if (tree !== '' && recorded === tree && git(['status', '--porcelain']) === '')
    process.stdout.write(`pre-push: fast PASS reused for tree ${tree}\n`);
  else if (hasFile(cwd, scopedCheck)) {
    const runScoped = () => {
      (runtime.quiet ?? (() => undefined))();
      return runner(
        'env',
        [
          ...proofEnvironment(cwd, prBody()),
          'node',
          scopedCheck,
          '--base',
          `origin/${target}`,
        ],
        cwd,
      );
    };
    const outputOf = (r: { stdout: string; stderr: string }) =>
      `${r.stdout}\n${r.stderr}`;
    let scoped = runScoped();
    // A failure made only of timeouts is host load until a rerun says otherwise: the rerun
    // passes (flaky), repeats on other files (named flake exit) or repeats on the same ones (red).
    if (scoped.code !== 0 && timeoutOnly(outputOf(scoped))) {
      const first = scoped;
      scoped = runScoped();
      if (scoped.code !== 0 && hostLoadFlake(outputOf(first), outputOf(scoped)))
        throw Object.assign(
          new Error(
            `refused push: host load: the scoped checks (${scopedCheck}) failed with timeouts only, on different tests each run; rerun ship\n${(scoped.stdout.trim() || scoped.stderr.trim()).slice(-4000)}`,
          ),
          { exitCode: exitHostLoadFlake },
        );
    }
    const rewritten = scoped.code === 0 ? git(['status', '--porcelain']) : '';
    if (scoped.code !== 0 || rewritten !== '')
      throw Object.assign(
        new Error(
          scoped.code !== 0
            ? `refused push: the scoped checks (${scopedCheck}) failed\n${(scoped.stdout.trim() || scoped.stderr.trim()).slice(-4000)}`
            : `refused push: the scoped checks rewrote files; commit them and ship again\n${rewritten}`,
        ),
        { exitCode: 65 },
      );
  }

  // A pull request that only adds or edits task records proves nothing a Proof command could
  // run: the record names work another PR delivers, so its Proof never runs here.
  const recordsOnly = changed
    .split('\n')
    .every((file) => /^tasks\/[^/]+\.json$/.test(file));
  const proofCommands = recordsOnly
    ? []
    : (runtime.proofOf ?? (() => []))(cwd, title);
  const proofs = proofCommands.map((command) => ({
    command,
    result: runner(
      'env',
      [...proofEnvironment(cwd, prBody()), 'sh', '-c', command],
      cwd,
    ),
  }));
  const failedProof = proofs.find(({ result }) => result.code !== 0);
  if (failedProof !== undefined)
    throw Object.assign(
      new Error(
        `refused push: Proof command \`${failedProof.command}\` exited ${failedProof.result.code}\n${(failedProof.result.stderr.trim() || failedProof.result.stdout.trim()).slice(-4000)}`,
      ),
      { exitCode: 81 },
    );
  // KRN-14: a defect's regression test is red on the pre-fix source, shown before the push.
  const baseRedLines: string[] = [];
  if (
    !recordsOnly &&
    (runtime.kindOf ?? (() => undefined))(cwd, title) === 'defect'
  ) {
    const verdict = (runtime.baseRed ?? baseRedProof)(
      cwd,
      `origin/${target}`,
      runner,
      proofEnvironment(cwd, prBody()),
    );
    const refusal = baseRedRefusal(verdict);
    if (refusal !== undefined)
      throw Object.assign(new Error(`refused push: ${refusal}`), {
        exitCode: 81,
      });
    if (verdict.kind === 'red')
      baseRedLines.push(
        '## Base red proof',
        '',
        ...verdict.cases.map((name) => `- fails on the base source: ${name}`),
      );
  }
  const proofRun =
    proofs.length === 0
      ? []
      : [
          '## Proof run',
          '',
          ...proofs.map(
            ({ command, result }) => `- \`${command}\`: exit ${result.code}`,
          ),
        ];
  const sections = [proofRun, baseRedLines].filter((lines) => lines.length > 0);
  const publishedBody =
    sections.length === 0
      ? body
      : (runtime.publish ?? publishBody)(
          cwd,
          `${prBody().trimEnd()}\n\n${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`,
        );

  const pushed = runner(
    'git',
    // No -u: an upstream is a .git/config write, which a running lane's sandbox placeholder
    // over .git/config.lock refuses; nothing reads the upstream.
    ['push', ...(force ? ['--force-with-lease'] : []), 'origin', branch],
    cwd,
  );
  if (pushed.code !== 0 && workflowsRejection.test(pushed.stderr)) {
    const files = changed
      .split('\n')
      .filter((file) => file.startsWith('.github/workflows/'));
    throw Object.assign(
      new Error(
        `refused push: the token lacks workflows write for ${files.join(', ')}\n${pushRemedy(pushed.stderr, force)}\nthe operator owns this grant; the lane is done, not blocked`,
      ),
      { exitCode: 83 },
    );
  }
  if (pushed.code !== 0)
    throw Object.assign(
      new Error(
        `push failed: ${pushed.stderr.trim()}\n${pushRemedy(pushed.stderr, force)}`,
      ),
      { exitCode: 70 },
    );

  afterPush = true;
  const openPr = async () =>
    (
      await gh([
        'pr',
        'list',
        '--repo',
        repo,
        '--head',
        branch,
        '--state',
        'open',
        '--json',
        'number',
        '--jq',
        '.[0].number // empty',
      ])
    ).trim();
  const existing = await openPr();
  let pr = existing === '' ? NaN : Number(existing);
  if (Number.isNaN(pr)) {
    // An unanswered create may have created the PR: look for it before each new try.
    for (let waited = 0; Number.isNaN(pr); ) {
      let created: string;
      try {
        created = await gh([
          'pr',
          'create',
          '--repo',
          repo,
          '--head',
          branch,
          '--base',
          target,
          '--title',
          title,
          '--body-file',
          publishedBody,
        ]);
      } catch (error) {
        if (
          !(error instanceof CommandFailure) ||
          answeredFailure(error.result.stderr) ||
          waited >= networkBudgetMs
        )
          throw error;
        await wait(networkBackoffCapMs);
        waited += networkBackoffCapMs;
        const found = await openPr();
        if (found !== '') pr = Number(found);
        continue;
      }
      pr = Number(/\/pull\/(\d+)\s*$/u.exec(created.trim())?.[1]);
      if (!Number.isInteger(pr))
        throw new Error(`gh pr create printed no PR url: ${created.trim()}`);
    }
  } else {
    await gh([
      'pr',
      'edit',
      String(pr),
      '--repo',
      repo,
      '--title',
      title,
      '--body-file',
      publishedBody,
    ]);
  }
  const head = git(['rev-parse', 'HEAD']);
  const lines = [`pr: #${pr} ${repo} ${head}`];
  const view = () => viewOf(pr);
  // Auto-merge fires on the first green Check, whatever the base did meanwhile, so ship merges
  // explicitly: only a head that contains the current base tip, pinned by --match-head-commit.
  const mergeCurrent = async (at: string): Promise<string | undefined> => {
    await fetchTarget();
    const onto = `origin/${target}`;
    const contains = runner(
      'git',
      ['merge-base', '--is-ancestor', onto, 'HEAD'],
      cwd,
    );
    if (contains.code > 1) checked(contains);
    // The ruleset does not require an up-to-date branch, so a base that moved on files the patch
    // does not touch merges on the Check it already has; the post-merge Check on the base covers
    // a semantic break. Anything unclear (overlap, unreadable diff, GitHub not MERGEABLE) rebases.
    const disjoint = async (): Promise<boolean> => {
      const patch = runner(
        'git',
        ['diff', '--name-only', `${onto}...HEAD`],
        cwd,
      );
      const moved = runner(
        'git',
        ['diff', '--name-only', `HEAD...${onto}`],
        cwd,
      );
      if (patch.code !== 0 || moved.code !== 0) return false;
      const touched = new Set(patch.stdout.split('\n').filter(Boolean));
      if (moved.stdout.split('\n').some((file) => touched.has(file)))
        return false;
      return (await view()).mergeable === 'MERGEABLE';
    };
    if (contains.code === 1 && !(await disjoint())) {
      const rebased = runner('git', ['rebase', onto], cwd);
      if (rebased.code !== 0) {
        runner('git', ['rebase', '--abort'], cwd);
        throw Object.assign(
          new Error(
            `verdict: conflict: ${onto} moved and the branch no longer rebases onto it; rebase by hand and rerun with --force\n${rebased.stderr.trim()}`,
          ),
          { exitCode: 76 },
        );
      }
      const pushed = runner(
        'git',
        ['push', '--force-with-lease', 'origin', branch],
        cwd,
      );
      if (pushed.code !== 0)
        throw Object.assign(new Error(`push failed: ${pushed.stderr.trim()}`), {
          exitCode: 70,
        });
      const updated = git(['rev-parse', 'HEAD']);
      lines.push(`updated: ${onto} moved; rebased onto it, now ${updated}`);
      return updated;
    }
    try {
      await gh([
        'pr',
        'merge',
        String(pr),
        '--repo',
        repo,
        '--squash',
        '--match-head-commit',
        at,
      ]);
    } catch (error) {
      if (
        error instanceof CommandFailure &&
        /head branch was modified|match-head-commit/iu.test(error.result.stderr)
      )
        throw Object.assign(
          new Error(
            `verdict: head moved: PR #${pr} no longer ends at ${at}: ${error.result.stderr.trim()}`,
          ),
          { exitCode: 77 },
        );
      // GitHub already accepted the merge and is still applying it: keep waiting for MERGED.
      if (
        error instanceof CommandFailure &&
        /merge already in progress/iu.test(error.result.stderr)
      )
        return undefined;
      throw error;
    }
    return undefined;
  };
  // Any run GitHub lists for the head that has not completed (queued, in progress or waiting) is a Check that
  // exists but has not reached the PR rollup yet, not a missing one.
  const queued = async (at: string) => {
    const text = await gh([
      'run',
      'list',
      '--repo',
      repo,
      '--commit',
      at,
      '--json',
      'status',
    ]);
    return z
      .array(z.object({ status: z.string() }))
      .parse(JSON.parse(text))
      .some((run) => run.status.toLowerCase() !== 'completed');
  };
  const checks = async (at: string): Promise<CheckFact[]> =>
    JSON.parse(
      await gh([
        'api',
        `repos/${repo}/commits/${at}/check-runs?filter=all&per_page=100`,
        '--jq',
        CHECK_FACT_FILTER,
      ]),
    ) as CheckFact[];
  const outcome = await waitForMerge({
    view,
    checks,
    queued,
    head,
    mergeCurrent,
    pr,
    sleep: wait,
    now: runtime.now ?? Date.now,
  });
  lines.push(...outcome.lines);
  if (outcome.merged !== undefined) {
    recordClose(
      pr,
      (await view().catch(() => undefined))?.statusCheckRollup ?? [],
    );
    lines.push(
      ...refreshAfterMerge(
        ownsProductRelease(worktree)
          ? () => runner('bash', [releaseScript], worktree)
          : undefined,
      ),
      `verdict: merged ${outcome.merged}`,
      cleanup(outcome.merged),
    );
    return lines.join('\n');
  }
  throw Object.assign(new Error(lines.join('\n')), {
    exitCode: outcome.exitCode,
  });
}

/**
 * Polls the PR until it merges or stops: a red or never-started Check (74, 69), a conflict (76),
 * a moved head (77), a closed PR (79), an open PR no rule releases (80), a
 * Check still pending at the bound (75).
 */
async function waitForMerge(options: {
  view: () => Promise<PrView>;
  /** The check runs of the head with their App ids: the required check is selected by name and App. */
  checks: (head: string) => Promise<CheckFact[]>;
  /** Whether GitHub lists a run queued for the head, though the PR shows no Check yet. */
  queued: (head: string) => Promise<boolean>;
  head: string;
  /** Called once per head after a green Check: merges it, or returns the new head after updating the branch to the base. */
  mergeCurrent: (head: string) => Promise<string | undefined>;
  pr: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<
  | { merged: string; lines: string[] }
  | { merged?: undefined; exitCode: number; lines: string[] }
> {
  let start = options.now();
  let head = options.head;
  let mergeBy: number | undefined;
  let requested = false;
  // The head before a branch update: the PR may keep reporting it until GitHub sees the push.
  let replaced: string | undefined;
  for (;;) {
    const pull = await options.view();
    const stop = (exitCode: number, ...lines: string[]) => ({
      exitCode,
      lines,
    });
    if (pull.state === 'MERGED') {
      // The merge was pinned to `head`: a merge at another head is somebody else's change, not this ship.
      if (pull.headRefOid !== head)
        return stop(
          77,
          `verdict: head moved: PR #${options.pr} merged at ${pull.headRefOid}, not ${head}`,
        );
      const sha = pull.mergeCommit?.oid ?? 'unknown';
      return { merged: sha, lines: [`merged: ${sha}`] };
    }
    if (pull.state === 'CLOSED')
      return stop(
        79,
        'merge: PR closed without merging',
        `verdict: closed unmerged PR #${options.pr}`,
      );
    if (replaced !== undefined && pull.headRefOid === replaced) {
      if (options.now() - start >= startTimeoutMs)
        return stop(
          69,
          `gate: PR #${options.pr} still shows ${replaced} ${startTimeoutMs / 1000}s after the branch update to ${head}`,
        );
      await options.sleep(pollMs);
      continue;
    }
    if (pull.headRefOid === head) replaced = undefined;
    if (pull.headRefOid !== head)
      return stop(
        77,
        `verdict: head moved: PR #${options.pr} is at ${pull.headRefOid}, not ${head}`,
      );
    if (pull.mergeable === 'CONFLICTING')
      return stop(
        76,
        `verdict: conflict: PR #${options.pr} conflicts with its base; rebase and rerun with --force`,
      );
    const check = selectRequiredCheck(await options.checks(head));
    const conclusion = check?.conclusion || undefined;
    if (
      check?.status === 'COMPLETED' &&
      conclusion !== undefined &&
      !isGreen(conclusion)
    ) {
      const run = /\/runs\/(\d+)/u.exec(check.detailsUrl ?? '')?.[1];
      return stop(
        74,
        ...(conclusion === 'CANCELLED'
          ? [
              `verdict: cancelled: the newest ${check.name} run was cancelled, not failed; rerun it or push a fresh head`,
            ]
          : []),
        `gate: ${check.name} concluded ${conclusion.toLowerCase()} on ${head}${run === undefined ? '' : ` in run ${run}; logs: gh run view ${run} --log-failed; rerun: gh run rerun ${run} --failed`}`,
      );
    }
    if (!requested && check?.status === 'COMPLETED' && isGreen(conclusion)) {
      const updated = await options.mergeCurrent(head);
      if (updated === undefined) requested = true;
      else {
        // A fresh head needs a fresh Check.
        replaced = head;
        head = updated;
        start = options.now();
        mergeBy = undefined;
        await options.sleep(pollMs);
        continue;
      }
    }
    const elapsed = options.now() - start;
    if (check?.status === 'COMPLETED' && conclusion !== undefined) {
      mergeBy ??= options.now() + mergeTimeoutMs;
      if (options.now() >= mergeBy)
        return stop(
          80,
          `merge: not observed within ${mergeTimeoutMs / 1000}s; after it merges run scripts/product-release.sh`,
          `verdict: open: merge requested but PR #${options.pr} is ${pull.mergeable ?? 'unknown'} (review or another required rule blocks it)`,
        );
    } else if (
      check === undefined &&
      elapsed >= startTimeoutMs &&
      !(await options.queued(head))
    )
      return stop(
        69,
        `gate: the Check never started on ${head} within ${startTimeoutMs / 1000}s`,
      );
    else if (elapsed >= gateTimeoutMs)
      return stop(
        75,
        `gate: the Check had not concluded on ${head} after ${gateTimeoutMs / 1000}s`,
      );
    await options.sleep(pollMs);
  }
}

/**
 * Refreshes the pinned Product entry once the PR merged, so `krn task` stays fresh without a
 * manual step. The PR is merged either way: a failed refresh only leaves the entry on its
 * previous commit, so it is a warning, not a failed ship.
 */
function refreshAfterMerge(
  refresh: (() => { code: number; stdout: string; stderr: string }) | undefined,
): string[] {
  if (refresh === undefined) return [];
  const result = refresh();
  return [
    ...(result.code === 0
      ? []
      : [
          `warning: release refresh failed (exit ${result.code}); run scripts/product-release.sh again: ${result.stderr.trim()}`,
        ]),
    ...result.stdout
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => `release: ${line}`),
  ];
}

function publishBody(cwd: string, text: string): string {
  const dir = resolve(cwd, '.krn/tmp');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, 'ship-body.md');
  writeFileSync(file, text);
  return file;
}

function parse(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      title: { type: 'string' },
      'body-file': { type: 'string' },
      repo: { type: 'string' },
      force: { type: 'boolean' },
      drop: { type: 'boolean' },
      worktree: { type: 'string' },
      base: { type: 'string' },
    },
  });
  return {
    title: values.title,
    bodyFile: values['body-file'],
    worktree: values.worktree,
    base: values.base,
    repo: values.repo,
    force: values.force === true,
    drop: values.drop === true,
  };
}

/**
 * What to do after a refused push. GitHub refuses a workflow file from an App token without the
 * `workflows` permission (verbatim: krn-works/krn-pilot-py adoption push), and every adoption PR
 * writes .github/workflows/ci.yml; a rebase cannot fix that, so the remedy names the permission.
 */
export function pushRemedy(stderr: string, force: boolean): string {
  if (workflowsRejection.test(stderr))
    return 'the token cannot write workflow files: grant the KRN GitHub App the Workflows (write) permission, or push this branch once with a user login holding the workflow scope (`env -u GH_TOKEN gh auth status` lists it), then rerun the same krn pr ship; the pushed branch is reused';
  return force
    ? 'fetch, rebase and rerun with --force'
    : 'after a rebase rerun with --force';
}

/** `krn pr ship`: runs the ship and keeps its pid file in the worktree for as long as it runs. */
export async function shipCommand(
  args: string[],
  runtime: Parameters<typeof shipRun>[1] = {},
): Promise<string> {
  let worktree: string | undefined;
  try {
    const caller = runtime.cwd ?? process.cwd();
    const named = parse(args).worktree;
    worktree = named === undefined ? caller : resolve(caller, named);
    markShipLive(worktree);
  } catch {
    /* Bad arguments are refused by the ship itself. */
  }
  try {
    return await shipRun(args, runtime);
  } finally {
    if (worktree !== undefined) clearShipLive(worktree);
  }
}
