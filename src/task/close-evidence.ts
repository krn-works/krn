// The close seam: `krn task close --as done` reads the clause ids stored at claim, asks `gh` for the
// closing PR and its aggregate Check, and hands one evidence row to a sink (the brain appends it to
// the exposure log). A missing claim file, PR or `gh` leaves the matching field null, never an error.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghPrViewSync } from '../repo/gh.ts';
import { mainCheckoutRoot } from './claims.ts';
import type { TaskId } from './record.ts';

export interface CloseEvidence {
  task: TaskId;
  /** The clause ids served at claim. */
  clauses: string[];
  pr: number | null;
  /** Conclusion of the aggregate `Check` run, lower case. */
  ci: string | null;
  hidden: 'pass' | 'fail' | null;
}

/** Writes the evidence of one closed task into the exposure log of the main checkout. */
export type CloseEvidenceSink = (main: string, evidence: CloseEvidence) => void;

function storedClauses(main: string, id: TaskId): string[] {
  const path = join(main, '.krn', 'task-claims', `${id}.clauses`);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      clauses?: unknown;
    };
    return Array.isArray(parsed.clauses)
      ? parsed.clauses.filter((c): c is string => typeof c === 'string')
      : [];
  } catch {
    return [];
  }
}

/** The PR of the current branch and its aggregate Check conclusion, from `gh pr view`. */
export function pullEvidence(root: string): {
  pr: number | null;
  ci: string | null;
} {
  const run = ghPrViewSync(root, 'number,statusCheckRollup');
  if (run.status !== 0) return { pr: null, ci: null };
  try {
    const view = JSON.parse(run.stdout) as {
      number?: unknown;
      statusCheckRollup?: { name?: string; conclusion?: string }[];
    };
    const check = view.statusCheckRollup?.find((c) => c.name === 'Check');
    const conclusion = check?.conclusion;
    return {
      pr: typeof view.number === 'number' ? view.number : null,
      ci:
        typeof conclusion === 'string' && conclusion !== ''
          ? conclusion.toLowerCase()
          : null,
    };
  } catch {
    return { pr: null, ci: null };
  }
}

/** Writes the evidence of a task that closed as done; a task that stored no clauses at claim writes nothing. */
export function closeEvidenceOf(
  root: string,
  id: TaskId,
  hidden: 'pass' | 'fail' | null,
  sink: CloseEvidenceSink,
): void {
  const main = mainCheckoutRoot(root);
  const clauses = storedClauses(main, id);
  if (clauses.length === 0) return;
  sink(main, { task: id, clauses, ...pullEvidence(root), hidden });
}
