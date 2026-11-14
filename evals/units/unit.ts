// Replayable eval unit: one pilot-repository task (base SHA, task text, hidden test file, PB spec).
// A unit is evals/units/<task-id>/unit.json plus the hidden test file it names; the hidden file stays out
// of the arm's worktree and is copied in only when grading. Usage: see evals/units/cli.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Unit {
  /** Task id in the pilot repository tracker. */
  id: string;
  /** Source repository, owner/name. */
  repo: string;
  /** Parent of the reference merge: the state the arms start from. */
  base: string;
  /** The merged fix: the state the hidden test must pass on. */
  reference: string;
  /** Task title plus body exactly as the pilot tracker held it at base. */
  task: { title: string; body: string };
  /** PB spec: the task's Outcome paragraph, the observable behaviour a plain harness is told. */
  spec: string;
  hidden: {
    /** File inside the unit directory; .txt so no linter, type checker or test runner picks it up. */
    file: string;
    /** Repository-relative path the file is copied to for grading. */
    dest: string;
  };
  /** Shell command run in the worktree before grading (dependencies, build). */
  install: string;
  /** Shell command run in the worktree; exit 0 is PASS. */
  test: string;
}

const SHA = /^[0-9a-f]{40}$/;

export function parseUnit(text: string): Unit {
  const u = JSON.parse(text) as Unit;
  const bad = (why: string): never => {
    throw new Error(`unit ${u?.id ?? '?'}: ${why}`);
  };
  if (!/^t-[a-z0-9]{7}$/.test(u.id ?? '')) bad('id is not a task id');
  if (!/^[\w.-]+\/[\w.-]+$/.test(u.repo ?? '')) bad('repo is not owner/name');
  if (!SHA.test(u.base ?? '')) bad('base is not a full SHA');
  if (!SHA.test(u.reference ?? '')) bad('reference is not a full SHA');
  if (u.base === u.reference) bad('base equals reference');
  if (!u.task?.title || !u.task.body) bad('task needs title and body');
  if (!u.spec) bad('spec is empty');
  if (!u.hidden?.file || !u.hidden.dest) bad('hidden needs file and dest');
  if (!u.install || !u.test) bad('install and test are required');
  return u;
}

export function loadUnits(dir: string): { unit: Unit; dir: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && existsSync(join(dir, e.name, 'unit.json')),
    )
    .map((e) => {
      const d = join(dir, e.name);
      return {
        unit: parseUnit(readFileSync(join(d, 'unit.json'), 'utf8')),
        dir: d,
      };
    });
}

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

export interface BuildInput {
  /** Clone of the pilot repository. */
  repoDir: string;
  repo: string;
  id: string;
  /** Commit that delivered the task; its first parent is the base. */
  merge: string;
  /** Lead-written hidden test file. */
  hiddenFile: string;
  hiddenDest: string;
  install: string;
  test: string;
  /** Output directory holding one directory per unit. */
  out: string;
}

export function outcomeOf(body: string): string {
  const m = /^Outcome:\s*(.+)$/m.exec(body);
  if (!m) throw new Error('task body has no Outcome line');
  return (m[1] as string).trim();
}

export function buildUnit(i: BuildInput): Unit {
  const reference = git(i.repoDir, 'rev-parse', `${i.merge}^{commit}`);
  const base = git(i.repoDir, 'rev-parse', `${reference}^1`);
  const record = JSON.parse(
    git(i.repoDir, 'show', `${base}:tasks/${i.id}.json`),
  ) as { title: string; body: string[] };
  const body = record.body.join('\n');
  const unit: Unit = {
    id: i.id,
    repo: i.repo,
    base,
    reference,
    task: { title: record.title, body },
    spec: outcomeOf(body),
    hidden: { file: 'hidden.txt', dest: i.hiddenDest },
    install: i.install,
    test: i.test,
  };
  const dir = join(i.out, i.id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(i.hiddenFile, join(dir, unit.hidden.file));
  writeFileSync(join(dir, 'unit.json'), `${JSON.stringify(unit, null, 2)}\n`);
  return unit;
}

export type Verdict = 'PASS' | 'FAIL';

/** Runs install and the hidden test on one commit in a throwaway worktree. */
export function gradeAt(
  repoDir: string,
  sha: string,
  unit: Unit,
  unitDir: string,
  scratch = tmpdir(),
): Verdict {
  const wt = mkdtempSync(join(scratch, 'unit-grade-'));
  rmSync(wt, { recursive: true });
  git(repoDir, 'worktree', 'add', '-q', '--detach', wt, sha);
  try {
    const dest = join(wt, unit.hidden.dest);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(unitDir, unit.hidden.file), dest);
    const run = (cmd: string) =>
      spawnSync('sh', ['-c', cmd], { cwd: wt, stdio: 'ignore' }).status;
    if (run(unit.install) !== 0) throw new Error(`install failed at ${sha}`);
    return run(unit.test) === 0 ? 'PASS' : 'FAIL';
  } finally {
    git(repoDir, 'worktree', 'remove', '--force', wt);
  }
}

export interface Verification {
  id: string;
  base: Verdict;
  reference: Verdict;
  ok: boolean;
}

/** A unit is valid when its hidden test is red on base and green on the reference fix. */
export function verifyUnit(
  repoDir: string,
  unit: Unit,
  unitDir: string,
  scratch?: string,
): Verification {
  const base = gradeAt(repoDir, unit.base, unit, unitDir, scratch);
  const reference = gradeAt(repoDir, unit.reference, unit, unitDir, scratch);
  return {
    id: unit.id,
    base,
    reference,
    ok: base === 'FAIL' && reference === 'PASS',
  };
}
