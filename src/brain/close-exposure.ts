// The brain's sink for a closed task: one exposure row, channel `close`, naming the clauses served at
// claim and the PR, Check conclusion and hidden-test result the task ended with.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendExposure,
  EXPOSURES_FILE,
  type Exposure,
  exposureOf,
} from './exposures.ts';

export function closeExposure(
  main: string,
  evidence: {
    task: string;
    clauses: string[];
    pr: number | null;
    ci: string | null;
    hidden: string | null;
  },
): void {
  appendExposure(
    main,
    exposureOf({
      run: `close-${evidence.task}`,
      task: evidence.task,
      channel: 'close',
      served: evidence.clauses,
      withheld: [],
      laneOk: true,
      evidence: {
        pr: evidence.pr,
        ci: evidence.ci,
        hidden: evidence.hidden,
      },
    }),
  );
}

/**
 * Completes the close row of a task once its PR merged: a row that still has neither a PR number nor
 * a Check conclusion (the lane closed before the PR existed) receives both. A row that carries either
 * is left alone, so a rerun of the ship never adds or rewrites a row.
 */
export function completeCloseExposure(
  main: string,
  done: { task: string; pr: number; ci: string | null },
): void {
  const path = join(main, EXPOSURES_FILE);
  if (!existsSync(path)) return;
  let changed = false;
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line;
      let row: Partial<Exposure>;
      try {
        row = JSON.parse(line) as Partial<Exposure>;
      } catch {
        return line;
      }
      const evidence = row.evidence;
      if (
        row.channel !== 'close' ||
        row.task !== done.task ||
        evidence === undefined ||
        evidence.pr !== null ||
        evidence.ci !== null
      )
        return line;
      changed = true;
      return JSON.stringify({
        ...row,
        evidence: { ...evidence, pr: done.pr, ci: done.ci },
      });
    });
  if (changed) writeFileSync(path, lines.join('\n'));
}
