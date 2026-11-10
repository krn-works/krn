// The retro skeleton `krn state retro` prints: the slice's measured facts from
// git (commits naming the task, their wall time, merged PR numbers) and one
// empty line per candidate category, so the lead writes only the lessons.
import { git } from './git.ts';
import { resolveRepositoryRoot } from './runs.ts';

const RETRO_CATEGORIES = [
  'checks',
  'reviewer rules',
  'steering',
  'navigation',
  'tool economy',
  'information access',
  'flakiness',
] as const;

interface TaskCommit {
  sha: string;
  at: Date;
  subject: string;
}

function taskCommits(root: string, task: string): TaskCommit[] {
  const log = git(root, [
    'log',
    '--fixed-strings',
    `--grep=${task}`,
    '--format=%h%x09%cI%x09%s',
    'HEAD',
  ]);
  if (!log.ok) throw new Error('git log failed; is this a git repository?');
  return log.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', at = '', ...rest] = line.split('\t');
      return { sha, at: new Date(at), subject: rest.join('\t') };
    });
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** Renders the window for a span; the caller owns the measure (src/outcome), state never imports it. */
type WindowReader = (
  from: string,
  to: string,
  mainRoot: string,
) => Promise<string>;

/** The main checkout: the first entry of `git worktree list`, which is where the window must be measured. */
function mainCheckout(root: string): string {
  const list = git(root, ['worktree', 'list', '--porcelain']);
  return (list.ok ? /^worktree (.+)$/m.exec(list.out)?.[1] : undefined) ?? root;
}

async function windowBlock(
  read: WindowReader | undefined,
  root: string,
  first: number,
  last: number,
): Promise<string[]> {
  if (!read) return [];
  const from = new Date(first).toISOString();
  const to = new Date(last).toISOString();
  try {
    const body = (await read(from, to, mainCheckout(root))).trimEnd();
    return [`Window ${from}..${to} (krn ledger, main checkout):`, body];
  } catch (error) {
    return [
      `Window ${from}..${to}: unavailable (${error instanceof Error ? error.message : String(error)})`,
    ];
  }
}

export async function renderRetro(
  repo: string,
  task: string,
  readWindow?: WindowReader,
): Promise<string> {
  if (!/^t-[a-z0-9]{7}$/.test(task)) throw new Error(`bad task id ${task}`);
  const { root } = resolveRepositoryRoot(repo);
  const commits = taskCommits(root, task);
  const prs = [
    ...new Set(
      commits.flatMap((commit) =>
        [...commit.subject.matchAll(/\(#(\d+)\)/g)].map((match) =>
          Number(match[1]),
        ),
      ),
    ),
  ].sort((a, b) => a - b);
  const times = commits
    .map((commit) => commit.at.getTime())
    .sort((a, b) => a - b);
  const first = times[0];
  const last = times.at(-1);
  const measured =
    first === undefined || last === undefined
      ? `- commits: none on HEAD name ${task}`
      : `- commits: ${commits.length} on HEAD name ${task}, ${new Date(first).toISOString()} to ${new Date(last).toISOString()} (${duration(last - first)})`;
  const window =
    first === undefined || last === undefined
      ? []
      : await windowBlock(readWindow, root, first, last);
  return [
    `Retro ${task} (measured from git; CI reruns: bin/krn ci logs --run <id>)`,
    measured,
    `- merged PRs: ${prs.length > 0 ? prs.map((pr) => `#${pr}`).join(' ') : 'none'}`,
    ...window,
    'Candidates (dispose each: check, then rule, then task; delete empty lines):',
    ...RETRO_CATEGORIES.map((category) => `- ${category}:`),
  ].join('\n');
}
