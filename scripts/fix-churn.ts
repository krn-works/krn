// Floor against fixing one edge case at a time: a fix(...) PR that touches a source file the base
// already fixed often in the window, or whose task already took fix commits after its feature,
// must name the shared root cause and its redesign (`Root cause:` and `Redesign:` body lines).
// History-based; runs no tests. `--report` lists the hot files and fix-chained tasks of the base.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Days of base history counted, ending at the base commit's own date. */
export const WINDOW_DAYS = 14;
/** Distinct earlier fix tasks on one source file that make it hot (a commit without a task id counts alone). */
export const FILE_LIMIT = 6;
/** Earlier fix commits of one task, after its first feat commit, that make it a fix chain. */
export const TASK_LIMIT = 2;

/** One commit of the base history: its subject and the files it touched. */
export type Commit = { subject: string; files: string[] };
type Git = (...args: string[]) => string;

const SOURCE = /^(?:src|scripts|bin)\/.+\.(?:ts|mts|mjs|js|cjs)$/u;
const TEST_FILE = /(?:^|\/)[^/]+\.test\.(?:ts|mts|mjs|js|cjs)$/u;
const TASK_ID = /\((t-[a-z0-9]{7})\)\s*(?:\(#\d+\))?\s*$/u;
const ROOT_CAUSE = /^\s*Root cause:\s*\S.{9,}/imu;
const REDESIGN = /^\s*Redesign:\s*(t-[a-z0-9]{7}|this PR)\b/imu;

/** A source file whose fixes count: code under src, scripts or bin, never a test. */
export const isSource = (path: string): boolean =>
  SOURCE.test(path) && !TEST_FILE.test(path);

const typeOf = (subject: string): string | undefined =>
  /^([a-z]+)(?:\([^)]*\))?!?:/u.exec(subject)?.[1];
const taskOf = (subject: string): string | undefined =>
  TASK_ID.exec(subject)?.[1];
/** How many distinct fixes the subjects hold: one per task id, one per subject without an id. */
export const distinct = (subjects: readonly string[]): number =>
  new Set(subjects.map((subject) => taskOf(subject) ?? subject)).size;

/** Hot files and fix-chained tasks of a history given newest first, as git log prints it: the earlier fix subjects of each. */
export function churn(commits: readonly Commit[]): {
  files: Map<string, string[]>;
  tasks: Map<string, string[]>;
} {
  const files = new Map<string, string[]>();
  const tasks = new Map<string, string[]>();
  const featured = new Set<string>();
  for (const commit of [...commits].reverse()) {
    const type = typeOf(commit.subject);
    const task = taskOf(commit.subject);
    if (type === 'feat' && task) featured.add(task);
    if (type !== 'fix') continue;
    for (const file of commit.files.filter(isSource))
      files.set(file, [...(files.get(file) ?? []), commit.subject]);
    if (task && featured.has(task))
      tasks.set(task, [...(tasks.get(task) ?? []), commit.subject]);
  }
  return { files, tasks };
}

/** The verdict for one PR. */
export function checkFixChurn({
  title,
  body = '',
  changed,
  commits,
  taskExists = () => true,
}: {
  title: string;
  body?: string;
  changed: readonly string[];
  commits: readonly Commit[];
  taskExists?: (id: string) => boolean;
}): {
  ok: boolean;
  overridden: boolean;
  findings: string[];
  problems: string[];
} {
  if (typeOf(title) !== 'fix')
    return { ok: true, overridden: false, findings: [], problems: [] };
  const history = churn(commits);
  const findings: string[] = [];
  for (const file of changed.filter(isSource)) {
    const earlier = history.files.get(file) ?? [];
    if (distinct(earlier) >= FILE_LIMIT)
      findings.push(
        `${file}: fixed for ${distinct(earlier)} tasks in the last ${WINDOW_DAYS} days:\n${earlier.map((s) => `    ${s}`).join('\n')}`,
      );
  }
  const task = taskOf(title);
  const chain = task ? (history.tasks.get(task) ?? []) : [];
  if (task && chain.length >= TASK_LIMIT)
    findings.push(
      `${task}: ${chain.length} fix commits after its feature merged:\n${chain.map((s) => `    ${s}`).join('\n')}`,
    );
  if (findings.length === 0)
    return { ok: true, overridden: false, findings, problems: [] };
  const problems: string[] = [];
  if (!ROOT_CAUSE.test(body))
    problems.push(
      'the body has no `Root cause: <the defect class these fixes share>` line',
    );
  // The match is case-insensitive, so "This PR" is the same claim as "this PR", never a task id.
  const redesign = REDESIGN.exec(body)?.[1];
  if (redesign === undefined)
    problems.push(
      'the body has no `Redesign: <task id | this PR>` line naming the redesign that ends the class',
    );
  else if (redesign.toLowerCase() !== 'this pr' && !taskExists(redesign))
    problems.push(`Redesign names ${redesign}, which has no tasks/ record`);
  return {
    ok: problems.length === 0,
    overridden: problems.length === 0,
    findings,
    problems,
  };
}

/** Base history of the window as `{subject, files}` newest first. */
export function readHistory(git: Git, base: string): Commit[] {
  const date = git('log', '-1', '--format=%cI', base).trim();
  const since = new Date(Date.parse(date) - WINDOW_DAYS * 86_400_000);
  const out = git(
    'log',
    '--no-merges',
    `--since=${since.toISOString()}`,
    '--format=%x1e%s',
    '--name-only',
    base,
  );
  return out
    .split('\x1e')
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      const [subject = '', ...files] = chunk.split('\n');
      return { subject, files: files.filter(Boolean) };
    });
}

function report(commits: readonly Commit[]): string {
  const { files, tasks } = churn(commits);
  const rank = (
    map: Map<string, string[]>,
    limit: number,
    count: (subjects: string[]) => number,
  ) =>
    [...map]
      .filter(([, s]) => count(s) >= limit)
      .sort((a, b) => count(b[1]) - count(a[1]));
  const lines = [`fix-churn report: last ${WINDOW_DAYS} days`];
  for (const [file, subjects] of rank(files, FILE_LIMIT, distinct))
    lines.push(`hot file ${distinct(subjects)} ${file}`);
  for (const [task, subjects] of rank(tasks, TASK_LIMIT, (s) => s.length))
    lines.push(`fix chain ${subjects.length} ${task}`);
  if (lines.length === 1) lines.push('none');
  return lines.join('\n');
}

if (import.meta.main) {
  const git: Git = (...args) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  const args = process.argv.slice(2);
  if (args[0] === '--report') {
    console.log(report(readHistory(git, args[1] ?? 'HEAD')));
    process.exit(0);
  }
  const [base, head] = args;
  if (!base || !head) {
    console.log('fix-churn: no base/head, skipped');
    process.exit(0);
  }
  let result: ReturnType<typeof checkFixChurn>;
  try {
    const changed = git(
      'diff',
      '--name-only',
      '--no-renames',
      `${base}...${head}`,
    )
      .split('\n')
      .filter(Boolean);
    result = checkFixChurn({
      title: process.env.PR_TITLE ?? '',
      body: process.env.PR_BODY ?? '',
      changed,
      commits: readHistory(git, base),
      taskExists: (id) => {
        try {
          git('cat-file', '-e', `${head}:tasks/${id}.json`);
          return true;
        } catch {
          return existsSync(join('tasks', `${id}.json`));
        }
      },
    });
  } catch (error) {
    // Fail open: a history this check cannot read is no finding.
    console.log(
      `fix-churn: history unreadable, skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(0);
  }
  for (const finding of result.findings) console.log(`fix-churn: ${finding}`);
  if (result.overridden)
    console.log('fix-churn: root cause and redesign named');
  if (!result.ok) {
    for (const problem of result.problems)
      console.error(`fix-churn: ${problem}`);
    console.error(
      'fix-churn: this is another fix of the same module or task; read the fixes above, name the class they share in `Root cause:`, and fix the class in this PR (`Redesign: this PR`) or link the open redesign task (`Redesign: t-…`)',
    );
    process.exit(1);
  }
}
