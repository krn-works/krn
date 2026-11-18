import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { isTestFile } from '../../brain/acceptance-clauses.ts';
import {
  changedSourceLines,
  type DiffCoverage,
  diffCoverage,
  lcovLines,
} from '../../brain/diff-coverage.ts';
import { findContract } from '../../repo/contract.ts';
import { git } from '../git-with.ts';

/** The one related-test command whose coverage maps to source lines: node's own runner on the untransformed files. */
const NODE_RELATED = 'node --test {files}';

/**
 * The diff coverage of a lane: its changed test files run under node's test coverage on the final tree, and the
 * changed source lines since the merge base with `base` are matched to the executed lines. Undefined (reported as
 * `diff-coverage n/a`) when the receiver's tests do not run on node's runner, the lane changed no test or no
 * source line, or the run left no report; the run never fails the lane.
 */
export function laneDiffCoverage(
  worktree: string,
  base: string,
  reportFile: string,
): DiffCoverage | undefined {
  if (findContract(worktree)?.contract.related?.trim() !== NODE_RELATED)
    return undefined;
  const range = `${base}...HEAD`;
  const changed = changedSourceLines(
    git(worktree, ['diff', '-U0', '--no-color', '--no-ext-diff', range]),
  );
  if (changed.size === 0) return undefined;
  const tests = git(worktree, ['diff', '--name-only', range])
    .split('\n')
    .filter((file) => isTestFile(file) && existsSync(join(worktree, file)));
  if (tests.length === 0) return undefined;
  rmSync(reportFile, { force: true });
  mkdirSync(join(reportFile, '..'), { recursive: true });
  try {
    // An inherited test context would make the inner runner report to the outer one instead of the file.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_V8_COVERAGE;
    spawnSync(
      process.execPath,
      [
        '--test',
        '--experimental-test-coverage',
        '--test-reporter=lcov',
        `--test-reporter-destination=${reportFile}`,
        ...tests,
      ],
      { cwd: worktree, env, stdio: 'ignore', timeout: 10 * 60 * 1000 },
    );
    if (!existsSync(reportFile)) return undefined;
    const executed = new Map(
      [...lcovLines(readFileSync(reportFile, 'utf8'))].map(([file, lines]) => [
        isAbsolute(file) ? relative(worktree, file) : file,
        lines,
      ]),
    );
    return diffCoverage(changed, executed);
  } finally {
    rmSync(reportFile, { force: true });
  }
}
