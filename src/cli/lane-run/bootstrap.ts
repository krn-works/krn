import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOOTSTRAP_TASK_TITLE,
  GREEN_BASE_TASK_TITLE,
} from '../../adopt/adopt.ts';
import { findContract, parseContractFile } from '../../repo/contract.ts';
import { getTask } from '../../task/store.ts';
import { git } from './git.ts';
import { settledRun } from './preflight.ts';

/** True when the task is the seeded first-test task of a repository in the bootstrap state. */
export function isBootstrapTask(worktree: string, task: string): boolean {
  try {
    return getTask(worktree, task).title === BOOTSTRAP_TASK_TITLE;
  } catch {
    return false;
  }
}

/** True when the task is the seeded green-base task: the one task a red baseline admits. */
export function isGreenBaseTask(worktree: string, task: string): boolean {
  try {
    return getTask(worktree, task).title === GREEN_BASE_TASK_TITLE;
  } catch {
    return false;
  }
}

/** True when the contract committed on origin/<base> is still vacuous (the repository has not left bootstrap). */
export function baseIsVacuous(worktree: string, base: string): boolean {
  try {
    return (
      parseContractFile(git(worktree, ['show', `origin/${base}:krn.json`]))
        .vacuous === true
    );
  } catch {
    return false;
  }
}

const SOURCE = /\.(?:js|mjs|cjs|ts|py|php|rb|go|rs|java)$/u;
const TESTISH =
  /(?:^|\/)(?:tests?|spec|__tests__|vendor|node_modules|dist|build)\/|\.(?:test|spec)\.|Test\.php$|_test\.(?:py|go)$|^test_/u;
const COMMENT =
  /^\s*(?:\/\/|#|\*|\/\*|<\?php|<\?|\?>|import\b|use\b|require|namespace\b|package\b)/u;

/** Up to three lines of a production file whose removal changes behavior: code with a call, an assignment or a return. */
function mutableLines(text: string): number[] {
  const lines = text.split('\n');
  const found: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim().length < 6 || COMMENT.test(line)) continue;
    if (!/\breturn\b|=|\(/u.test(line)) continue;
    found.push(index);
    if (found.length === 3) break;
  }
  return found;
}

/**
 * The bootstrap proof after the session: the new test command is green on the delivered tree, goes red when
 * one production line is deleted and green again on revert. A test that stays green under every
 * mutation tried does not exercise production code and proves nothing. A string is the failure.
 */
export function bootstrapProof(
  worktree: string,
  command: string,
): { verified: string; flaky: string[] } | { failure: string } {
  const run = (line: string) =>
    spawnSync(line, {
      cwd: worktree,
      shell: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
  const contract = findContract(worktree)?.contract;
  if (contract?.vacuous)
    return {
      failure:
        'the bootstrap task did not clear the vacuous contract: krn.json still carries "vacuous"; set the new test command and drop "vacuous"',
    };
  const green = settledRun(run, command);
  if (green.run.status !== 0)
    return {
      failure: `the new test command ${command} is red on the delivered tree (exit ${green.run.status ?? 'signal'})`,
    };
  const files = git(worktree, ['ls-files'])
    .split('\n')
    .filter((file) => SOURCE.test(file) && !TESTISH.test(file))
    .slice(0, 12);
  let attempts = 0;
  for (const file of files) {
    const path = join(worktree, file);
    const original = readFileSync(path, 'utf8');
    for (const index of mutableLines(original)) {
      if (attempts++ >= 8) break;
      const lines = original.split('\n');
      const removed = (lines[index] as string).trim();
      lines[index] = '';
      writeFileSync(path, lines.join('\n'));
      let red: number | null;
      try {
        red = run(command).status;
      } finally {
        writeFileSync(path, original);
      }
      if (red === 0) continue;
      const back = run(command);
      if (back.status !== 0)
        return {
          failure: `${command} stays red after reverting the mutation of ${file}`,
        };
      return {
        verified: `${command} ran green, went red with line ${index + 1} of ${file} deleted (${removed.slice(0, 60)}) and green on revert; bootstrap state cleared`,
        flaky: green.flaky,
      };
    }
  }
  return {
    failure: `${command} stays green with a production line deleted (${attempts} mutation${attempts === 1 ? '' : 's'} tried): the new test does not exercise production code`,
  };
}
