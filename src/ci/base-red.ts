import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Runner } from './command.ts';

/** What the base run of a defect branch's tests showed. */
export type BaseRedVerdict =
  | { kind: 'red'; cases: string[] }
  | { kind: 'green'; tests: string[] }
  | { kind: 'no-test' }
  | { kind: 'load-error'; tests: string[]; detail: string };

const testFile = /\.test\.[cm]?[jt]s$/u;
// Everything under test/ is the test side: a helper the new test needs stays as it is on the branch.
const testSide = (path: string) =>
  testFile.test(path) || path.startsWith('test/');
const assertionBlock = /^\s*code: 'ERR_ASSERTION'/u;
const caseHeader = /^\s*not ok \d+ - (.+)$/u;
const blockEnd = /^\s*\.\.\.$/u;

/** The names of the cases a TAP report shows failing by assertion; a file-level load failure carries no assertion. */
export function assertionFailures(tap: string): string[] {
  const names: string[] = [];
  let current: string | undefined;
  for (const line of tap.split('\n')) {
    const header = caseHeader.exec(line);
    if (header !== null) current = header[1]?.trim();
    else if (assertionBlock.test(line) && current !== undefined)
      names.push(current);
    else if (blockEnd.test(line)) current = undefined;
  }
  return [...new Set(names)];
}

interface Swap {
  path: string;
  /** The branch's bytes, or none where the branch deletes the file. */
  branch: Buffer | undefined;
  mode: number | undefined;
  base: Buffer;
}

/**
 * Runs the branch's changed or added test files against the base versions of its changed non-test
 * files, inside `cwd` so the worktree's dependencies resolve. The base versions are written over the
 * branch's files for the run and the branch's bytes come back afterwards, whatever the run did.
 */
export function baseRedProof(
  cwd: string,
  baseRef: string,
  runner: Runner,
  env: string[] = [],
): BaseRedVerdict {
  const git = (args: string[]) => {
    const result = runner('git', args, cwd);
    if (result.code !== 0)
      throw new Error(
        `git ${args.join(' ')} exited ${result.code}: ${result.stderr.trim()}`,
      );
    return result;
  };
  const mergeBase = git(['merge-base', baseRef, 'HEAD']).stdout.trim();
  const entries = git([
    'diff',
    '--name-status',
    '--no-renames',
    `${mergeBase}...HEAD`,
  ])
    .stdout.split('\n')
    .filter((line) => line !== '')
    .map((line) => ({
      status: line.charAt(0),
      path: line.slice(line.indexOf('\t') + 1),
    }));
  const tests = entries
    .filter(({ status, path }) => status !== 'D' && testFile.test(path))
    .map(({ path }) => path);
  if (tests.length === 0) return { kind: 'no-test' };

  const swaps: Swap[] = entries
    .filter(({ status, path }) => status !== 'A' && !testSide(path))
    .map(({ status, path }) => ({
      path,
      branch: status === 'D' ? undefined : readFileSync(join(cwd, path)),
      mode: status === 'D' ? undefined : statSync(join(cwd, path)).mode,
      base:
        git(['show', `${mergeBase}:${path}`]).stdoutBytes ?? Buffer.alloc(0),
    }));
  const before = git(['status', '--porcelain']).stdout;
  let ran: ReturnType<Runner>;
  try {
    for (const swap of swaps) {
      mkdirSync(dirname(join(cwd, swap.path)), { recursive: true });
      writeFileSync(join(cwd, swap.path), swap.base);
    }
    ran = runner(
      'env',
      // A test runner around this process must not turn the nested run into a child report.
      [
        '-u',
        'NODE_TEST_CONTEXT',
        ...env,
        'node',
        '--test',
        '--test-reporter=tap',
        ...tests,
      ],
      cwd,
      undefined,
      900_000,
    );
  } finally {
    for (const swap of swaps) {
      if (swap.branch === undefined)
        rmSync(join(cwd, swap.path), { force: true });
      else {
        writeFileSync(join(cwd, swap.path), swap.branch);
        if (swap.mode !== undefined) chmodSync(join(cwd, swap.path), swap.mode);
      }
    }
  }
  if (git(['status', '--porcelain']).stdout !== before)
    throw new Error(
      'the base run left the worktree changed; restore it before shipping',
    );
  const cases = assertionFailures(ran.stdout);
  if (cases.length > 0) return { kind: 'red', cases };
  if (ran.code === 0) return { kind: 'green', tests };
  return {
    kind: 'load-error',
    tests,
    detail: (ran.stderr.trim() || ran.stdout.trim()).slice(-2000),
  };
}

/** The refusal text of a verdict that does not prove the tests red on the base, or undefined when it does. */
export function baseRedRefusal(verdict: BaseRedVerdict): string | undefined {
  if (verdict.kind === 'red') return undefined;
  if (verdict.kind === 'no-test')
    return 'a defect task needs a changed or added test file, and the branch carries none';
  if (verdict.kind === 'green')
    return `${verdict.tests.join(', ')} passes on the base source: the regression test does not reproduce the defect`;
  return `${verdict.tests.join(', ')} fails on the base source without an assertion (a load or import error is not a red test)\n${verdict.detail}`;
}
