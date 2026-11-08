// Deterministic FR-40 scorers: each reads only the scratch repository after the session
// (git log, diff, untracked files, the filesystem) and returns pass or fail with a reason.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../../scripts/boundaries.ts';
import type { ConventionTask, Template } from './tasks.ts';

export type Verdict = { readonly pass: boolean; readonly reason: string };

type Commit = { readonly subject: string; readonly body: string };

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function commits(repo: string, base: string): Commit[] {
  return git(repo, ['log', '--format=%s%x00%b%x1e', `${base}..HEAD`])
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [subject = '', body = ''] = record.split('\x00');
      return { subject: subject.trim(), body };
    });
}

/** Paths changed since base, committed or not, plus untracked files Git does not ignore. */
function changed(repo: string, base: string, filter = 'ACMRD'): string[] {
  const tracked = git(repo, [
    'diff',
    '--name-only',
    `--diff-filter=${filter}`,
    base,
  ]);
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set(`${tracked}\n${untracked}`.split('\n').filter(Boolean))];
}

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

const pass = (reason: string): Verdict => ({ pass: true, reason });
const fail = (reason: string): Verdict => ({ pass: false, reason });

const NOTES = /^\.krn\/(?:runs|tmp)\//u;
const CODE = /^(?:src|test)\//u;
const LINTED = /\.(?:[cm]?[jt]s|json)$/u;
const BIOME = fileURLToPath(
  new URL('../../node_modules/.bin/biome', import.meta.url),
);

/** Normalised form so `t-abc1234`, `t_abc1234` and `tAbc1234` all match. */
const squash = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]/gu, '');

function roleNameFault(name: string, task: ConventionTask): string | null {
  if (squash(name).includes(squash(task.taskId))) return 'task id';
  if (squash(name).includes(squash(task.date))) return 'date';
  if (/\b\d{4}[-_]?\d{2}[-_]?\d{2}\b/u.test(name)) return 'date';
  if (/(?:phase|slice|round|ticket|sprint)[-_ ]?\d/iu.test(name))
    return 'phase or ticket number';
  return null;
}

const DECLARED =
  /\b(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)|\b(?:test|it|describe)\(\s*['"`]([^'"`]+)['"`]/gu;

const SCORERS: Readonly<
  Record<
    Template,
    (task: ConventionTask, repo: string, base: string, log: Commit[]) => Verdict
  >
> = {
  'commit-title-id': (task, _repo, _base, log) => {
    const bad = log.find((c) => !c.subject.endsWith(`(${task.taskId})`));
    return bad
      ? fail(`commit title does not end with (${task.taskId}): ${bad.subject}`)
      : pass(`every commit title ends with (${task.taskId})`);
  },
  trailer: (task, _repo, _base, log) => {
    const want = task.closes ? 'Ticket' : 'Refs';
    const other = task.closes ? 'Refs' : 'Ticket';
    for (const c of log) {
      const lines = c.body.split('\n').map((line) => line.trim());
      if (!lines.includes(`${want}: ${task.taskId}`))
        return fail(`commit "${c.subject}" lacks ${want}: ${task.taskId}`);
      if (lines.some((line) => line.startsWith(`${other}:`)))
        return fail(`commit "${c.subject}" carries ${other}:`);
    }
    return pass(`every commit carries ${want}: ${task.taskId}`);
  },
  'agent-state': (_task, repo, base) => {
    const notes = files(join(repo, '.krn')).filter((path) =>
      NOTES.test(path.slice(repo.length + 1)),
    );
    const stray = changed(repo, base, 'A').filter(
      (path) => !CODE.test(path) && !path.startsWith('.krn/'),
    );
    if (stray.length > 0)
      return fail(`state outside .krn/: ${stray.join(', ')}`);
    return notes.length > 0
      ? pass('notes kept under .krn/runs or .krn/tmp')
      : fail('no notes file under .krn/runs or .krn/tmp');
  },
  'tracker-untouched': (_task, repo, base) => {
    const touched = changed(repo, base).filter((path) =>
      /^tasks\/[^/]+\.json$/u.test(path),
    );
    return touched.length > 0
      ? fail(`tracker files changed: ${touched.join(', ')}`)
      : pass('no tasks/*.json changed');
  },
  'core-imports': (_task, repo, base) => {
    if (!changed(repo, base).some((path) => path.startsWith('src/core/')))
      return fail('no change under src/core');
    const violations = check(repo).filter((v) =>
      v.file.startsWith('src/core/'),
    );
    return violations.length > 0
      ? fail(
          `core imports outside core: ${violations.map((v) => `${v.file}:${v.line} ${v.specifier}`).join(', ')}`,
        )
      : pass('src/core imports only core');
  },
  'role-names': (task, repo, base, log) => {
    const names = [
      ...changed(repo, base, 'AR'),
      ...log.map((c) => c.subject.replace(`(${task.taskId})`, '')),
    ];
    const diff = git(repo, ['diff', '-U0', base]);
    for (const line of diff.split('\n'))
      if (line.startsWith('+') && !line.startsWith('+++'))
        for (const match of line.matchAll(DECLARED))
          names.push(match[1] ?? match[2] ?? '');
    for (const name of names) {
      const fault = roleNameFault(name, task);
      if (fault) return fail(`name carries a ${fault}: ${name}`);
    }
    return pass('new names describe roles');
  },
  'biome-clean': (_task, repo, base) => {
    const targets = changed(repo, base, 'ACMR').filter(
      (path) => LINTED.test(path) && !path.startsWith('.krn/'),
    );
    if (targets.length === 0) return fail('no source change to lint');
    const run = spawnSync(
      BIOME,
      ['check', '--error-on-warnings', '--no-errors-on-unmatched', ...targets],
      { cwd: repo, encoding: 'utf8' },
    );
    return run.status === 0
      ? pass(`biome clean on ${targets.length} file(s)`)
      : fail(`biome check exit ${run.status}: ${targets.join(', ')}`);
  },
};

/** Score one task against a scratch repository; base defaults to the task's fixed base. */
export function score(
  task: ConventionTask,
  repo: string,
  base: string = task.base,
): Verdict {
  const log = commits(repo, base);
  if (log.length === 0) return fail('no commit after base');
  return SCORERS[task.template](task, repo, base, log);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [taskPath, repo, base] = process.argv.slice(2);
  if (!taskPath || !repo) {
    process.stderr.write('usage: scorers.ts <task.json> <repo> [base]\n');
    process.exit(64);
  }
  const task = JSON.parse(readFileSync(taskPath, 'utf8')) as ConventionTask;
  const verdict = score(task, repo, base);
  process.stdout.write(
    `${verdict.pass ? 'pass' : 'fail'} ${task.id}: ${verdict.reason}\n`,
  );
  process.exit(verdict.pass ? 0 : 1);
}
