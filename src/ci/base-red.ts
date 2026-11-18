import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { findContract, relatedCommand } from '../repo/contract.ts';
import { shellWords } from '../repo/shell-text.ts';
import type { Runner } from './command.ts';

/** What the base run of a defect branch's tests showed. */
export type BaseRedVerdict =
  | { kind: 'red'; cases: string[] }
  | { kind: 'green'; tests: string[] }
  | { kind: 'no-test' }
  | { kind: 'load-error'; tests: string[]; detail: string };

const jsTestFile = /\.test\.[cm]?[jt]s$/u;
const pythonTestFile = /(?:^|\/)test_[^/]*\.py$|_test\.py$/u;
const isTestFile = (path: string) =>
  jsTestFile.test(path) || pythonTestFile.test(path);
// Everything under test/ or tests/ is the test side: a helper the new test needs stays as it is on the branch.
const testSide = (path: string) =>
  isTestFile(path) || path.startsWith('test/') || path.startsWith('tests/');
// unittest reports an assertion failure as FAIL (an error of any other kind is ERROR).
const unittestFailure = /^FAIL: (\S+) \((.+)\)$/u;
// pytest's short summary: a failure by assertion carries `assert ...` or AssertionError, any other exception names itself.
const pytestFailure = /^FAILED (\S+?)(?: - (.*))?$/u;
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

/** The names of the cases a Python runner's output (unittest or pytest, either stream) shows failing by assertion. */
export function pythonAssertionFailures(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split('\n')) {
    const unit = unittestFailure.exec(line);
    if (unit !== null) {
      names.push(`${unit[2]}`);
      continue;
    }
    const py = pytestFailure.exec(line);
    if (py !== null && /^(?:assert\b|AssertionError)/u.test(py[2] ?? ''))
      names.push(py[1] ?? '');
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
    .filter(({ status, path }) => status !== 'D' && isTestFile(path))
    .map(({ path }) => path);
  const jsTests = tests.filter((path) => jsTestFile.test(path));
  const pythonTests = tests.filter((path) => !jsTestFile.test(path));
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
  const ran: Array<{ code: number; cases: string[]; detail: string }> = [];
  try {
    for (const swap of swaps) {
      mkdirSync(dirname(join(cwd, swap.path)), { recursive: true });
      writeFileSync(join(cwd, swap.path), swap.base);
    }
    if (jsTests.length > 0) {
      const result = runner(
        'env',
        // A test runner around this process must not turn the nested run into a child report.
        [
          '-u',
          'NODE_TEST_CONTEXT',
          ...env,
          'node',
          '--test',
          '--test-reporter=tap',
          ...jsTests,
        ],
        cwd,
        undefined,
        900_000,
      );
      ran.push({
        code: result.code,
        cases: assertionFailures(result.stdout),
        detail: result.stderr.trim() || result.stdout.trim(),
      });
    }
    if (pythonTests.length > 0) {
      const result = runner(
        'env',
        [
          'PYTHONDONTWRITEBYTECODE=1',
          ...env,
          'sh',
          '-c',
          pythonCommand(cwd, pythonTests),
        ],
        cwd,
        undefined,
        900_000,
      );
      const output = `${result.stderr}\n${result.stdout}`;
      ran.push({
        code: result.code,
        cases: pythonAssertionFailures(output),
        detail: output.trim(),
      });
    }
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
  const cases = ran.flatMap((result) => result.cases);
  if (cases.length > 0) return { kind: 'red', cases };
  if (ran.every((result) => result.code === 0)) return { kind: 'green', tests };
  return {
    kind: 'load-error',
    tests,
    detail: ran
      .filter((result) => result.code !== 0)
      .map((result) => result.detail)
      .join('\n')
      .slice(-2000),
  };
}

/** The repository contract's own Python runner for these test files, unittest when the contract names none. */
function pythonCommand(cwd: string, files: string[]): string {
  const contract = findContract(cwd)?.contract;
  if (contract?.related && /\b(?:unittest|pytest)\b/u.test(contract.related))
    return relatedCommand(contract, files);
  return `python3 -m unittest ${shellWords(files)}`;
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
