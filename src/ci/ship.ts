import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  CommandFailure,
  checked,
  github,
  type Runner,
  run,
  sleep,
} from '../deliver/transport.ts';
import { titleProblem } from './commit-title.ts';
import { withReplyCheck } from './gh-reply.ts';
import { gitLockError } from './git-lock.ts';
import { rebaseGenerated } from './rebase-generated.ts';
import { waitCommand } from './wait.ts';

export const shipUsage =
  'Usage: krn pr ship --title <type(scope): outcome (t-id)> --body-file <path> [--repo <owner/repo>] [--force] [--worktree <path>] [--base <branch>]; the PR targets --base, else the repo contract base; run from the repository root with --worktree (or inside the branch worktree, which leaves the shell in a removed directory): pushes the branch, creates (or reuses) the PR, enables squash auto-merge, waits through the merge, then removes the worktree and branch; prints the `krn ci wait` lines; exits 0 only when the PR merged (a merged PR with a failed pinned-entry refresh or cleanup still exits 0 with a warning); a rerun after the merge only cleans up; otherwise 65 instruction-bytes rule failed before the push, 66 empty diff against the base, 74 failed gate, 71 gh returned an empty or truncated reply twice (transport fault; the message names the gh command), 81 a task Proof command exited non-zero before the push (--force does not bypass it), 83 the push was rejected because the App token lacks the workflows permission for a .github/workflows edit (the message names the files and the remedy), 82 the repository deploys on a push to the base branch and krn.json lacks "deploy": "acknowledged" (no push, no auto-merge), 75 timeout, 76 conflict, 77 head moved, 78 auto-merge not enabled, 79 PR closed unmerged, 80 still open and blocked, 64 usage or refused title';

/** Exit codes for a ship whose wait ended without a merge. */
const unmergedExitCodes = [
  [/^verdict: not merging\b/mu, 78],
  [/^verdict: closed unmerged\b/mu, 79],
  [/^verdict: open\b/mu, 80],
] as const;

const gitLockAttempts = 5;
const workflowsRejection = /without `?workflows`? permission/u;
const instructionBytesRule = 'test/rules/instruction-bytes.test.ts';

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
    /** The remedy text when the worktree deploys on a push to `base` and krn.json does not acknowledge it, else undefined; the cli supplies it. */
    deployRefusal?: (cwd: string, base: string) => string | undefined;
    /** The runnable Proof commands of the task the title names, read from the worktree; the cli supplies it. */
    proofOf?: (cwd: string, title: string) => string[];
    /** The PR body to publish: `text` is the body file plus the proof record; the default writes it under .krn/tmp of `cwd`. */
    publish?: (cwd: string, text: string) => string;
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
  const gh = withReplyCheck(
    runtime.gh ?? ((a) => github(a, cwd, runner, wait)),
  );
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
  const cleanup = () => {
    if (worktree === main) return 'cleanup: skipped (not a linked worktree)';
    try {
      git(['worktree', 'remove', '--force', worktree], main);
      git(['branch', '-D', branch], main);
    } catch (error) {
      return `warning: cleanup failed (${(error as Error).message.split('\n')[0]}); rerun krn pr ship to clean up\nmain checkout: ${main}`;
    }
    return `cleanup: removed worktree ${worktree} and branch ${branch}\nmain checkout: ${main}`;
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
    return [
      `pr: #${mergedPr} ${repo} ${localHead}`,
      `verdict: merged ${mergedSha}`,
      cleanup(),
    ].join('\n');
  }

  // Parallel lanes share one object store: retry a fetch another git blocks.
  for (let attempt = 1; ; attempt++) {
    const fetched = runner('git', ['fetch', '-q', 'origin', target], cwd);
    if (fetched.code === 0) break;
    if (attempt >= gitLockAttempts || !gitLockError.test(fetched.stderr))
      checked(fetched);
    await wait(attempt * 1000);
  }
  // A conflict confined to generated files is regenerated here; any other conflict exits 76.
  const rebased = rebaseGenerated(cwd, target, runner);
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

  const proofs = (runtime.proofOf ?? (() => []))(cwd, title).map((command) => ({
    command,
    result: runner('sh', ['-c', command], cwd),
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
          `${readFileSync(body, 'utf8').trimEnd()}\n\n## Proof run\n\n${proofs.map(({ command, result }) => `- \`${command}\`: exit ${result.code}`).join('\n')}\n`,
        );

  const pushed = runner(
    'git',
    // No -u: an upstream is a .git/config write, which a running lane's sandbox placeholder
    // over .git/config.lock refuses; nothing reads the upstream.
    [
      'push',
      ...(force || rebased ? ['--force-with-lease'] : []),
      'origin',
      branch,
    ],
    cwd,
  );
  if (pushed.code !== 0 && workflowsRejection.test(pushed.stderr))
    throw Object.assign(
      new Error(
        `refused push: the token lacks workflows write for ${changed
          .split('\n')
          .filter((file) => file.startsWith('.github/workflows/'))
          .join(', ')}\n${pushRemedy(pushed.stderr, force)}`,
      ),
      { exitCode: 83 },
    );
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
      // A create retried after a timeout finds the PR its first attempt opened;
      // gh names that PR's url in the refusal.
      const opened =
        error instanceof CommandFailure
          ? /already exists:\s*(\S+\/pull\/\d+)/u.exec(error.result.stderr)?.[1]
          : undefined;
      if (opened === undefined) throw error;
      created = opened;
    }
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
  await gh(['pr', 'merge', String(pr), '--repo', repo, '--auto', '--squash']);

  const head = git(['rev-parse', 'HEAD']);
  const base = git(['rev-parse', `origin/${target}`]);
  const waitArgs = [
    '--repo',
    repo,
    '--pr',
    String(pr),
    '--head',
    head,
    '--base',
    base,
  ];
  const waited = await waitCommand(waitArgs, {
    ...runtime,
    cwd: worktree,
    run: runner,
    gh,
    sleep: wait,
  });
  const lines = [`pr: #${pr} ${repo} ${head}`, waited];
  if (/^verdict: merged /mu.test(waited)) {
    lines.push(cleanup());
    return lines.join('\n');
  }
  const exitCode =
    unmergedExitCodes.find(([verdict]) => verdict.test(waited))?.[1] ?? 74;
  throw Object.assign(new Error(lines.join('\n')), { exitCode });
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
