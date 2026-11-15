import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Grades the test a worker added in each merged outside row: run on the row base it should be red
// (a fix row) and on the merged tree green. A test-only row covers behavior that already exists, so
// it is green on both; the table keeps that apart from a red-on-base grade. The logic up to main()
// is pure and tested; main() fetches only PR refs of the public remote.

export const publicRemote = 'https://github.com/krn-works/krn.git';
// Pull requests that carry the operator's own code: never fetched.
const operatorPulls = { from: 868, to: 878 };

export function assertPublicPull(number: number): void {
  if (!Number.isInteger(number) || number <= 0)
    throw new Error(`outside-testgrade: bad pull number: ${number}`);
  if (number >= operatorPulls.from && number <= operatorPulls.to)
    throw new Error(`outside-testgrade: pull ${number} is operator code`);
}

const testPathPattern =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|Test\.php$|(^|\/)test_[^/]*\.py$/u;

/** The files of a change that are tests; trackers and sources never count. */
export function testFiles(changed: string[]): string[] {
  return changed.filter(
    (file) => !file.startsWith('tasks/') && testPathPattern.test(file),
  );
}

/**
 * The command that runs the added tests: pytest for Python files (in the row's venv when its
 * install step makes one), else the row's own command.
 */
export function testCommand(
  files: string[],
  rowCommand: string,
  rowInstall = '',
): string {
  const python = files.filter((file) => file.endsWith('.py'));
  if (python.length > 0 && python.length === files.length)
    return rowInstall.includes('.venv')
      ? `.venv/bin/python -m pytest -q ${python.join(' ')}`
      : `PYTHONPATH=. pytest -q ${python.join(' ')}`;
  return rowCommand;
}

export type Grade =
  | 'red-then-green'
  | 'green-on-both'
  | 'red-on-merge'
  | 'red-on-both';

export function grade(baseExit: number, mergedExit: number): Grade {
  if (mergedExit !== 0) return baseExit !== 0 ? 'red-on-both' : 'red-on-merge';
  return baseExit !== 0 ? 'red-then-green' : 'green-on-both';
}

export interface Row {
  pull: number;
  merged: string;
  kind: string;
  files: string[];
  baseExit: number;
  mergedExit: number;
}

export interface Summary {
  rows: number;
  redOnBase: number;
  greenOnMerge: number;
  redThenGreen: number;
}

export function summarize(rows: Row[]): Summary {
  return {
    rows: rows.length,
    redOnBase: rows.filter((row) => row.baseExit !== 0).length,
    greenOnMerge: rows.filter((row) => row.mergedExit === 0).length,
    redThenGreen: rows.filter(
      (row) => grade(row.baseExit, row.mergedExit) === 'red-then-green',
    ).length,
  };
}

/** A fix row changes sources beside its test; a test-only row only adds coverage. */
export function rowKind(changed: string[]): string {
  const sources = changed.filter(
    (file) => !file.startsWith('tasks/') && !testFiles([file]).length,
  );
  const code = sources.filter((file) => !/^krn\.json$|\.md$/u.test(file));
  return code.length > 0 ? 'fix' : 'test-only';
}

export function renderTable(rows: Row[]): string {
  const lines = [
    '| PR | merged | kind | test files | base exit | merged exit | grade |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| #${row.pull} | ${row.merged} | ${row.kind} | ${row.files.join(', ')} | ${row.baseExit} | ${row.mergedExit} | ${grade(row.baseExit, row.mergedExit)} |`,
    ),
  ];
  const sum = summarize(rows);
  lines.push(
    '',
    `Rows: ${sum.rows}. Red on base: ${sum.redOnBase}/${sum.rows}. Green on merge: ${sum.greenOnMerge}/${sum.rows}. Red on base then green on merge: ${sum.redThenGreen}/${sum.rows}.`,
  );
  return lines.join('\n');
}

function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

function runIn(cwd: string, command: string): number {
  return (
    spawnSync('bash', ['-c', command], {
      cwd,
      encoding: 'utf8',
      timeout: 300000,
    }).status ?? 1
  );
}

/** Grades one pull request inside a throwaway clone; the merged tree is the pull head's tree. */
export function gradePull(pull: number, merged: string, scratch: string): Row {
  assertPublicPull(pull);
  const dir = join(scratch, `pull-${pull}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    git(dir, ['init', '-q']);
    git(dir, ['remote', 'add', 'origin', publicRemote]);
    git(dir, ['fetch', '-q', '--depth=2', 'origin', `refs/pull/${pull}/head`]);
    const changed = git(dir, [
      'diff',
      '--name-only',
      'FETCH_HEAD^',
      'FETCH_HEAD',
    ])
      .split('\n')
      .filter(Boolean);
    const files = testFiles(changed);
    git(dir, ['checkout', '-q', 'FETCH_HEAD']);
    const row = JSON.parse(readFileSync(join(dir, 'krn.json'), 'utf8')) as {
      test: string;
      install?: string;
    };
    const command = testCommand(files, row.test, row.install);
    // Dependencies install once on the merged tree and stay (untracked) for the base run.
    if (row.install) runIn(dir, row.install);
    const mergedExit = runIn(dir, command);
    git(dir, ['checkout', '-q', 'FETCH_HEAD^']);
    // The base plus only the worker's test files: the command comes from the merged tree.
    git(dir, ['checkout', 'FETCH_HEAD', '--', ...files]);
    const baseExit = runIn(dir, command);
    return {
      pull,
      merged,
      kind: rowKind(changed),
      files,
      baseExit,
      mergedExit,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  // args: --out <file> <pull>:<merged-sha>...
  const args = process.argv.slice(2);
  const out = args[0] === '--out' ? (args[1] as string) : undefined;
  const scratch =
    process.env.KRN_TESTGRADE_SCRATCH ?? join(tmpdir(), 'krn-testgrade');
  const rows = args
    .filter((arg) => /^\d+:[0-9a-f]+$/u.test(arg))
    .map((arg) => {
      const [pull, merged] = arg.split(':') as [string, string];
      return gradePull(Number(pull), merged, scratch);
    });
  const table = renderTable(rows);
  if (out) writeFileSync(out, `${table}\n`);
  console.log(table);
  rmSync(scratch, { recursive: true, force: true });
}
