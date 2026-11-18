// The proof line of a lane run: what the brain's defaults did for this lane, counted from the lane's own
// records (the brief it was given, the commits and tests it made, the Stop refusals its transcript shows).
import { clauseProof } from './acceptance-clauses.ts';
import { type DiffCoverage, diffCoverageText } from './diff-coverage.ts';

export type Proof = {
  /** Clauses of the brief the lane proved (a marked test, or a declared not-reproducible line). */
  clauses: number;
  /** Clauses the brief stated, or the clauses the worker wrote when the brief stated under two. */
  clausesTotal: number;
  /** 1 when the lane's first commit changed a test file that fails at the base, else 0 (a test already green at the base is not red-first). */
  redFirst: number;
  /** Modules the brief's Precedent section named. */
  precedent: number;
  /** Stop refusals the session met. */
  stopRefusals: number;
  /** Of the changed source lines, the ones the lane's tests executed; undefined when the receiver has no coverage source. */
  diffCoverage?: DiffCoverage;
};

const TEST_PATH =
  /(?:^|\/)(?:tests?|spec|__tests__)\/|(?:Test\.php|_test\.(?:go|py|rs)|(?:^|\/)test_[^/]+\.py|\.(?:test|spec)\.[a-z]+)$/u;

/** The clause texts of the brief's `Acceptance clauses (cover every one):` section; empty when the worker writes its own. */
export function briefClauses(brief: string): string[] {
  const at = brief.indexOf('Acceptance clauses (cover every one):');
  if (at < 0) return [];
  const clauses: string[] = [];
  for (const line of brief.slice(at).split('\n').slice(1)) {
    const match = /^\d{1,2}\.\s+(.*)$/u.exec(line);
    if (match === null) break;
    clauses.push(match[1] ?? '');
  }
  return clauses;
}

/** Modules named by the brief's Precedent section: `### path` headings, else the sibling bullets. */
export function precedentModules(brief: string): number {
  const at = brief.indexOf('Precedent (');
  if (at < 0) return 0;
  const section = brief.slice(at);
  const headings = section.match(/^### `[^`]+`/gmu)?.length ?? 0;
  if (headings > 0) return headings;
  return section.match(/^- `[^`]+`$/gmu)?.length ?? 0;
}

/** The Stop refusals of a session transcript: one per stop_hook_summary line that carries an error. */
export function countStopRefusals(transcript: string): number {
  let count = 0;
  for (const line of transcript.split('\n')) {
    if (!line.includes('stop_hook_summary')) continue;
    try {
      const event = JSON.parse(line) as {
        subtype?: unknown;
        hookErrors?: unknown;
      };
      if (
        event.subtype === 'stop_hook_summary' &&
        Array.isArray(event.hookErrors) &&
        event.hookErrors.some((e) => String(e).trim() !== '')
      )
        count++;
    } catch {
      // A torn line is not a refusal.
    }
  }
  return count;
}

/** The lane's proof counts. `tests` maps each changed test file (test files only) to its text; `messages` is the lane's commit bodies. */
export function proofOf(input: {
  brief: string;
  tests: ReadonlyMap<string, string>;
  messages: string;
  firstCommitFiles: readonly string[];
  /** Changed test files that fail against the base source. */
  redAtBase: readonly string[];
  stopRefusals: number;
  diffCoverage?: DiffCoverage | undefined;
}): Proof {
  const { clauses } = clauseProof({
    stated: briefClauses(input.brief),
    tests: input.tests,
    messages: input.messages,
  });
  return {
    clauses: clauses.filter((clause) => clause.proven).length,
    clausesTotal: clauses.length,
    redFirst: input.firstCommitFiles.some(
      (f) => TEST_PATH.test(f) && input.redAtBase.includes(f),
    )
      ? 1
      : 0,
    precedent: precedentModules(input.brief),
    stopRefusals: input.stopRefusals,
    ...(input.diffCoverage === undefined
      ? {}
      : { diffCoverage: input.diffCoverage }),
  };
}

/** The one line a lane run prints and logs. */
export function proofLine(p: Proof): string {
  return `proof: clauses ${p.clauses}/${p.clausesTotal}, red-first ${p.redFirst}, precedent ${p.precedent} modules, stop refusals ${p.stopRefusals}, ${diffCoverageText(p.diffCoverage)}`;
}

/** Whether the message states a blocker on a line of its own, bold or plain: the one reader for the Stop hook and the lane run. */
export function statesBlocker(message: unknown): boolean {
  return (
    typeof message === 'string' && /^\s*\**BLOCKER:\**\s*\S/mu.test(message)
  );
}
