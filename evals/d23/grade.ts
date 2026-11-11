// Hidden-test grading of one replayed patch, SWE-bench style. The tests the merged pull request added or
// changed are applied to the arm tree: files that fail on the parent and pass on the merge are
// FAIL_TO_PASS, the other changed files and the rest of the suite are PASS_TO_PASS. Functional
// correctness and scope conformance are separate columns. Offline: no model session is started.
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { harnessPlan, layHarness } from './harness.ts';

export interface Exec {
  code: number;
  out: string;
}

export function exec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 600_000,
): Promise<Exec> {
  return new Promise((done) => {
    // A nested `node --test` inside a test run would see NODE_TEST_CONTEXT and run nothing.
    const { NODE_TEST_CONTEXT: _inherited, ...env } = process.env;
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, out });
    });
  });
}

const git = (cwd: string, ...args: string[]) => exec('git', args, cwd);

export interface HiddenChange {
  status: string;
  path: string;
}

export const isTestFile = (path: string) =>
  /\.test\.(ts|js|mjs|cjs)$/.test(path);

/** Paths under test/ the merged change added, modified or deleted: test files and their fixtures. */
export async function hiddenChanges(
  repo: string,
  parent: string,
  merge: string,
): Promise<HiddenChange[]> {
  const { out } = await git(
    repo,
    'diff',
    '--name-status',
    '--no-renames',
    parent,
    merge,
    '--',
    'test',
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      return { status: status ?? '', path: path ?? '' };
    });
}

/** Out-of-scope paths by the protocol's rule: tracker, roadmap, agent instructions and workflow files. */
export function outOfScope(files: string[]): string[] {
  return files.filter((f) =>
    /^(tasks\/|docs\/program\/roadmap\.md|\.claude\/|\.agents\/|CLAUDE\.md|AGENTS\.md|\.github\/)/.test(
      f,
    ),
  );
}

/** Test files the full-suite log reports as failing, relative to the clone it ran in. */
export function failingFiles(log: string, dir: string): string[] {
  const found = new Set<string>();
  const lines = log.split('\n');
  lines.forEach((line, i) => {
    if (!line.startsWith('not ok')) return;
    for (const next of lines.slice(i + 1, i + 7)) {
      const m = /location: '([^']*?)(?::\d+:\d+)?'/.exec(next);
      if (m?.[1]) {
        found.add(m[1].replace(`${dir}/`, ''));
        break;
      }
    }
  });
  return [...found].sort();
}

const nodeTest = (dir: string, files: string[]) =>
  exec('node', ['--test', '--test-concurrency=1', ...files], dir, 300_000);

/** A checkout of `commit`, under the replay harness when the spec names one. */
async function prepare(
  spec: UnitSpec,
  dir: string,
  commit: string,
): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, '..'), { recursive: true });
  await git(resolve(dir, '..'), 'clone', '-q', '--no-checkout', spec.repo, dir);
  await git(dir, 'checkout', '-q', commit);
  if (spec.harnessRef)
    layHarness(
      spec.repo,
      dir,
      spec.harnessRef,
      harnessPlan(spec.repo, spec.harnessRef, spec.parent, spec.merge),
    );
  if (spec.nodeModules)
    symlinkSync(spec.nodeModules, join(dir, 'node_modules'));
}

async function overlay(
  dir: string,
  merge: string,
  changes: HiddenChange[],
): Promise<void> {
  for (const c of changes) {
    if (c.status === 'D') rmSync(join(dir, c.path), { force: true });
    else await git(dir, 'checkout', merge, '--', c.path);
  }
}

export interface UnitSpec {
  repo: string;
  workRoot: string;
  parent: string;
  merge: string;
  nodeModules?: string;
  /** Run the whole suite as PASS_TO_PASS; off for fixtures. */
  fullSuite: boolean;
  /** Ref whose harness files every graded tree runs under (evals/d23/harness.ts); unset: the parent's own. */
  harnessRef?: string;
}

export interface Classified {
  failToPass: string[];
  passToPassHidden: string[];
  validOnMerge: boolean;
  changes: HiddenChange[];
}

/** Split the hidden test files into FAIL_TO_PASS and PASS_TO_PASS by running them on parent and merge. */
export async function classify(
  spec: UnitSpec,
  tag: string,
): Promise<Classified> {
  const changes = await hiddenChanges(spec.repo, spec.parent, spec.merge);
  const tests = changes
    .filter((c) => c.status !== 'D' && isTestFile(c.path))
    .map((c) => c.path);
  const dir = join(spec.workRoot, `${tag}.parent`);
  await prepare(spec, dir, spec.parent);
  await overlay(dir, spec.merge, changes);
  const failToPass: string[] = [];
  const passToPassHidden: string[] = [];
  for (const f of tests) {
    ((await nodeTest(dir, [f])).code === 0
      ? passToPassHidden
      : failToPass
    ).push(f);
  }
  rmSync(dir, { recursive: true, force: true });
  const mdir = join(spec.workRoot, `${tag}.merge`);
  await prepare(spec, mdir, spec.merge);
  let validOnMerge = true;
  for (const f of failToPass) {
    if ((await nodeTest(mdir, [f])).code !== 0) validOnMerge = false;
  }
  rmSync(mdir, { recursive: true, force: true });
  return { failToPass, passToPassHidden, validOnMerge, changes };
}

export interface ArmGrade {
  /** False when the arm produced no patch (a crashed or rate-limited session): no result, not a failure. */
  ran: boolean;
  applied: boolean;
  /** Paths the patch creates that already exist on the parent; skipped so the rest applies. */
  excluded: string[];
  /** Last lines of each failing hidden test's output. */
  failureTail: Record<string, string>;
  failToPass: Record<string, boolean>;
  passToPassHidden: Record<string, boolean>;
  regressions: string[];
  fullSuiteRan: boolean;
  functional: boolean;
  outOfScope: string[];
  scopeClean: boolean;
}

export async function gradeArm(
  spec: UnitSpec,
  cls: Classified,
  patchPath: string,
  filesPath: string,
  tag: string,
): Promise<ArmGrade> {
  const files = existsSync(filesPath)
    ? readFileSync(filesPath, 'utf8').split('\n').filter(Boolean)
    : [];
  const oos = outOfScope(files);
  const dir = join(spec.workRoot, tag);
  await prepare(spec, dir, spec.parent);
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  const ran = patch.trim() !== '';
  let applied = true;
  const excluded: string[] = [];
  if (ran) {
    let r = await git(dir, 'apply', '--whitespace=nowarn', patchPath);
    // An arm can recreate files its workspace lacked (plain arm) or edit harness files laid over the
    // parent (KRN arm); those paths are skipped and recorded, the rest is graded.
    const failed = [
      ...r.out.matchAll(
        /error: (?:patch failed: )?([^:\n]+?)(?::\d+)?(?:: (?:already exists in working directory|does not exist in index|No such file or directory|patch does not apply))?$/gm,
      ),
    ]
      .map((m) => m[1] ?? '')
      .filter((f, i, all) => f && !f.includes(' ') && all.indexOf(f) === i);
    if (r.code !== 0 && failed.length > 0) {
      excluded.push(...failed);
      r = await git(
        dir,
        'apply',
        '--whitespace=nowarn',
        ...failed.map((f) => `--exclude=${f}`),
        patchPath,
      );
    }
    applied = r.code === 0;
  }
  const empty: ArmGrade = {
    ran,
    applied,
    excluded,
    failureTail: {},
    failToPass: {},
    passToPassHidden: {},
    regressions: [],
    fullSuiteRan: false,
    functional: false,
    outOfScope: oos,
    scopeClean: oos.length === 0,
  };
  if (!applied) {
    rmSync(dir, { recursive: true, force: true });
    return empty;
  }
  await overlay(dir, spec.merge, cls.changes);
  const failToPass: Record<string, boolean> = {};
  const passToPassHidden: Record<string, boolean> = {};
  const failureTail: Record<string, string> = {};
  const hiddenRun = async (f: string) => {
    const r = await nodeTest(dir, [f]);
    if (r.code !== 0) failureTail[f] = r.out.split('\n').slice(-40).join('\n');
    return r.code === 0;
  };
  for (const f of cls.failToPass) failToPass[f] = await hiddenRun(f);
  for (const f of cls.passToPassHidden)
    passToPassHidden[f] = await hiddenRun(f);
  const regressions: string[] = [];
  if (spec.fullSuite) {
    const full = await exec('npm', ['test'], dir, 900_000);
    const hidden = new Set([...cls.failToPass, ...cls.passToPassHidden]);
    for (const f of failingFiles(full.out, dir)) {
      if (hidden.has(f) || !existsSync(join(dir, f))) continue;
      // A file outside the hidden set is a regression only if it fails alone on the arm and passes on the parent.
      if ((await nodeTest(dir, [f])).code === 0) continue;
      const pdir = join(spec.workRoot, `${tag}.parent-check`);
      await prepare(spec, pdir, spec.parent);
      const onParent = await nodeTest(pdir, [f]);
      rmSync(pdir, { recursive: true, force: true });
      if (onParent.code === 0) regressions.push(f);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  const hiddenOk = [
    ...Object.values(failToPass),
    ...Object.values(passToPassHidden),
  ].every(Boolean);
  return {
    ...empty,
    failureTail,
    failToPass,
    passToPassHidden,
    regressions,
    fullSuiteRan: spec.fullSuite,
    functional: ran && hiddenOk && regressions.length === 0,
  };
}
