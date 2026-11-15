// The proof line of a lane run: what the brain's defaults did for this lane, counted from the lane's own
// records (the brief it was given, the commits and tests it made, the Stop refusals its transcript shows).
import { clauseMarker, declaresNotReproducible } from './acceptance-clauses.ts';

export type Proof = {
  /** Clauses of the brief the lane proved (a marked test, or a declared not-reproducible line). */
  clauses: number;
  /** Clauses the brief stated, or the clauses the worker wrote when the brief stated under two. */
  clausesTotal: number;
  /** 1 when the lane's first commit changed a test file, else 0. */
  redFirst: number;
  /** Modules the brief's Precedent section named. */
  precedent: number;
  /** Stop refusals the session met. */
  stopRefusals: number;
};

const TEST_PATH =
  /(?:^|\/)(?:tests?|spec|__tests__)\/|(?:Test\.php|_test\.(?:go|py|rs)|(?:^|\/)test_[^/]+\.py|\.(?:test|spec)\.[a-z]+)$/u;

/** The numbered clauses of the brief's `Acceptance clauses (cover every one):` section; empty when the worker writes its own. */
export function briefClauseNumbers(brief: string): number[] {
  const at = brief.indexOf('Acceptance clauses (cover every one):');
  if (at < 0) return [];
  const numbers: number[] = [];
  for (const line of brief.slice(at).split('\n').slice(1)) {
    const match = /^(\d{1,2})\.\s/u.exec(line);
    if (match === null) break;
    numbers.push(Number(match[1]));
  }
  return numbers;
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

/** The lane's proof counts. `tests` maps each changed test file to its text; `messages` is the lane's commit bodies. */
export function proofOf(input: {
  brief: string;
  tests: ReadonlyMap<string, string>;
  messages: string;
  firstCommitFiles: readonly string[];
  stopRefusals: number;
}): Proof {
  const stated = briefClauseNumbers(input.brief);
  const texts = [...input.tests.values()];
  const proven = (n: number) =>
    texts.some((text) => clauseMarker(n).test(text)) ||
    declaresNotReproducible(input.messages, n);
  // A brief that states under two clauses makes the worker write its own: every distinct number it marked.
  const numbers =
    stated.length > 0
      ? stated
      : Array.from({ length: 30 }, (_, i) => i + 1).filter(proven);
  return {
    clauses: numbers.filter(proven).length,
    clausesTotal: numbers.length,
    redFirst: input.firstCommitFiles.some((f) => TEST_PATH.test(f)) ? 1 : 0,
    precedent: precedentModules(input.brief),
    stopRefusals: input.stopRefusals,
  };
}

/** The one line a lane run prints and logs. */
export function proofLine(p: Proof): string {
  return `proof: clauses ${p.clauses}/${p.clausesTotal}, red-first ${p.redFirst}, precedent ${p.precedent} modules, stop refusals ${p.stopRefusals}`;
}
