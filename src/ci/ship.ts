import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { gitLockError } from '../repo/shell-text.ts';
import { recordShip } from '../repo/ship-record.ts';
import { CommandFailure, checked, type Runner, run } from './command.ts';
import { titleProblem } from './commit-title.ts';
import { assertNoConflict } from './conflict-check.ts';
import { readFastPass } from './fast-pass.ts';

export const shipUsage =
  'Usage: krn pr ship --title <type(scope): outcome (t-id)> --body-file <path> [--repo <owner/repo>] [--force] [--worktree <path>] [--base <branch>]; the PR targets --base, else the repo contract base; run from the repository root with --worktree (or inside the branch worktree): pushes the branch, creates (or reuses) the PR, waits for a green Check, rebases onto the base when the base moved since (a fresh Check runs), then merges explicitly with --match-head-commit and waits through the merge, then records the merge and leaves the worktree and branch for the next `krn lane start` to prune; prints the gate, merge and `verdict:` lines; exits 0 only when the PR merged (a merged PR with a failed pinned-entry refresh still exits 0 with a warning); a rerun after the merge only records it; otherwise 65 instruction-bytes rule failed before the push, 66 empty diff against the base, 74 failed gate, 81 a task Proof command exited non-zero before the push (--force does not bypass it), 83 the push was rejected because the App token lacks the workflows permission for a .github/workflows edit (the message names the files and the remedy), 82 the repository deploys on a push to the base branch and krn.json lacks "deploy": "acknowledged" (no push, no auto-merge), 75 timeout, 76 conflict with the base, before the push or after the base moved during the wait, 77 head moved, 79 PR closed unmerged, 80 still open and blocked, 64 usage or refused title';

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
const pollMs = 10_000;
const gateTimeoutMs = 1_800_000;
const startTimeoutMs = 300_000;
const mergeTimeoutMs = 600_000;
const concluded = z.enum([
  'SUCCESS',
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'NEUTRAL',
  'SKIPPED',
  'STARTUP_FAILURE',
  'ACTION_REQUIRED',
  'STALE',
]);
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
    .default([]),
});
type PrView = z.infer<typeof prView>;
/** The aggregate Check, whether its job is named `Check` or `<caller job> / Check`. */
const aggregateCheck = /(?:^|\/ )Check$/u;

/**
 * The newest aggregate Check of the head: a rerun or a superseded run leaves older runs in the
 * rollup, and only the latest one speaks for the head. Ordered by start time, later entry on a tie.
 */
function newestCheck(
  rollup: PrView['statusCheckRollup'],
): PrView['statusCheckRollup'][number] | undefined {
  let newest: PrView['statusCheckRollup'][number] | undefined;
  for (const run of rollup) {
    if (!aggregateCheck.test(run.name ?? '')) continue;
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

export async function shipCommand(
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
    /** The remedy text when the worktree deploys on a push to `base` and krn.json does not acknowledge it, else undefined; the cli supplies it. */
    deployRefusal?: (cwd: string, base: string) => string | undefined;
    /** The runnable Proof commands of the task the title names, read from the worktree; the cli supplies it. */
    proofOf?: (cwd: string, title: string) => string[];
    /** The PR body to publish: `text` is the body file plus the proof record; the default writes it under .krn/tmp of `cwd`. */
    publish?: (cwd: string, text: string) => string;
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
  const gh =
    runtime.gh ??
    (async (a) => {
      const result = scoped('gh', a, cwd, undefined, ghTimeoutMs);
      if (result.code !== 0) throw new CommandFailure(result);
      return result.stdout;
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
  const repo =
    values.repo ??
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
  // The PR is merged by now: a refused removal is a warning, never a failed ship.
  const task =
    process.env.KRN_TASK ?? /\((t-[a-z0-9]{7})\)\s*$/u.exec(title)?.[1];
  // The lane ends here: the worktree and branch stay, and the lead prunes merged lanes at the next lane start.
  const cleanup = (sha: string) => {
    recordShip(main, { branch, sha, ...(task ? { task } : {}) });
    return `lane: worktree ${worktree} and branch ${branch} kept; the next krn lane start prunes merged lanes
main checkout: ${main}`;
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
  const recorded = (runtime.fastPass ?? readFastPass)(cwd);
  if (tree !== '' && recorded === tree && git(['status', '--porcelain']) === '')
    process.stdout.write(`pre-push: fast PASS reused for tree ${tree}\n`);
  else if (hasFile(cwd, scopedCheck)) {
    const scoped = runner(
      'node',
      [scopedCheck, '--base', `origin/${target}`],
      cwd,
    );
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

  // PR_BODY as CI sets it: a check that reads the body (weak-tests' Weakens-tests line) sees
  // the same text before the push as on the PR.
  const proofCommands = (runtime.proofOf ?? (() => []))(cwd, title);
  const prBody = proofCommands.length === 0 ? '' : readFileSync(body, 'utf8');
  const proofs = proofCommands.map((command) => ({
    command,
    result: runner('env', [`PR_BODY=${prBody}`, 'sh', '-c', command], cwd),
  }));
  const failedProof = proofs.find(({ result }) => result.code !== 0);
  if (failedProof !== undefined)
    throw Object.assign(
      new Error(
        `refused push: Proof command \`${failedProof.command}\` exited ${failedProof.result.code}\n${(failedProof.result.stderr.trim() || failedProof.result.stdout.trim()).slice(-4000)}`,
      ),
      { exitCode: 81 },
    );
  const publishedBody =
    proofs.length === 0
      ? body
      : (runtime.publish ?? publishBody)(
          cwd,
          `${prBody.trimEnd()}\n\n## Proof run\n\n${proofs.map(({ command, result }) => `- \`${command}\`: exit ${result.code}`).join('\n')}\n`,
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

  const existing = (
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
  let pr = existing === '' ? NaN : Number(existing);
  if (Number.isNaN(pr)) {
    const created = await gh([
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
    pr = Number(/\/pull\/(\d+)\s*$/u.exec(created.trim())?.[1]);
    if (!Number.isInteger(pr))
      throw new Error(`gh pr create printed no PR url: ${created.trim()}`);
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
    if (contains.code === 1) {
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
      throw error;
    }
    return undefined;
  };
  const outcome = await waitForMerge({
    view,
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
    const check = newestCheck(pull.statusCheckRollup);
    const conclusion = concluded.safeParse(check?.conclusion).data;
    if (
      check?.status === 'COMPLETED' &&
      conclusion !== undefined &&
      conclusion !== 'SUCCESS' &&
      conclusion !== 'NEUTRAL' &&
      conclusion !== 'SKIPPED'
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
    if (
      !requested &&
      check?.status === 'COMPLETED' &&
      (conclusion === 'SUCCESS' ||
        conclusion === 'NEUTRAL' ||
        conclusion === 'SKIPPED')
    ) {
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
    } else if (check === undefined && elapsed >= startTimeoutMs)
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
