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
import { waitCommand } from './wait.ts';

export const shipUsage =
  'Usage: krn pr ship --title <type(scope): outcome (t-id)> --body-file <path> [--repo <owner/repo>] [--force] [--worktree <path>] [--base <branch>]; the PR targets --base, else the repo contract base; run from the repository root with --worktree (or inside the branch worktree, which leaves the shell in a removed directory): pushes the branch, creates (or reuses) the PR, enables squash auto-merge, waits through the merge, then removes the worktree and branch; prints the `krn ci wait` lines; exits like `krn ci wait`, where a merged PR with a failed pinned-entry refresh still exits 0 with a warning (65 instruction-bytes rule failed before the push, 74 failed gate, 75 timeout, 76 conflict, 77 head moved), 64 usage or refused title';

/** Transient git refusals while a parallel lane holds a ref or index lock. */
export const gitLockError = /cannot lock ref|Unable to create '[^']*\.lock'/u;
const gitLockAttempts = 5;
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
  const gh = runtime.gh ?? ((a) => github(a, cwd, runner, wait));
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

  const rule = runner('node', ['--test', instructionBytesRule], cwd);
  if (rule.code !== 0)
    throw Object.assign(
      new Error(
        `refused push: ${instructionBytesRule} failed\n${(rule.stderr.trim() || rule.stdout.trim()).slice(-4000)}`,
      ),
      { exitCode: 65 },
    );

  const pushed = runner(
    'git',
    ['push', '-u', ...(force ? ['--force-with-lease'] : []), 'origin', branch],
    cwd,
  );
  if (pushed.code !== 0)
    throw Object.assign(
      new Error(
        `push failed: ${pushed.stderr.trim()}${force ? '' : '\nafter a rebase rerun with --force'}`,
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
        body,
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
      body,
    ]);
  }
  await gh(['pr', 'merge', String(pr), '--repo', repo, '--auto', '--squash']);

  // Parallel lanes share one object store: retry a fetch another git blocks.
  for (let attempt = 1; ; attempt++) {
    const fetched = runner('git', ['fetch', '-q', 'origin', target], cwd);
    if (fetched.code === 0) break;
    if (attempt >= gitLockAttempts || !gitLockError.test(fetched.stderr))
      checked(fetched);
    await wait(attempt * 1000);
  }
  const head = git(['rev-parse', 'HEAD']);
  const base = git(['rev-parse', `origin/${target}`]);
  const worktree = git(['rev-parse', '--show-toplevel']);
  const main = dirname(
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const cleanup = () => {
    if (worktree === main) return 'cleanup: skipped (not a linked worktree)';
    git(['worktree', 'remove', '--force', worktree], main);
    git(['branch', '-D', branch], main);
    return `cleanup: removed worktree ${worktree} and branch ${branch}\nmain checkout: ${main}`;
  };
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
  if (/^verdict: merged /mu.test(waited)) lines.push(cleanup());
  return lines.join('\n');
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
