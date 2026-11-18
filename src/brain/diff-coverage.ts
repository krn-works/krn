// Diff coverage of a lane: of the source lines its change adds or modifies, how many its tests execute.
// The changed lines come from a `git diff -U0`; the executed lines from an lcov report (`DA:<line>,<count>`).
import { isTestFile } from './acceptance-clauses.ts';

export type DiffCoverage = {
  /** Changed source lines the tests executed. */
  covered: number;
  /** Changed source lines counted. */
  changed: number;
  /** The changed lines no test executed, as `file:line`. */
  uncovered: string[];
};

/** Files a JavaScript coverage report can speak for. */
const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
/** Lines that carry no code: blank, or a comment only. */
const NO_CODE = /^\s*(?:$|\/\/|\/\*|\*)/u;
/** How many uncovered lines the proof line names before it counts the rest. */
const LISTED = 10;

/** The source lines a unified diff adds or modifies, per new-side file: test files, non-scripts and lines without code are left out. */
export function changedSourceLines(diff: string): Map<string, number[]> {
  const changed = new Map<string, number[]>();
  let file: string | undefined;
  let line = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('+++ ')) {
      const path = text.slice(4).replace(/^b\//u, '').trim();
      file =
        path === '/dev/null' || isTestFile(path) || !SCRIPT.test(path)
          ? undefined
          : path;
      continue;
    }
    if (text.startsWith('--- ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk !== null) {
      line = Number(hunk[1]);
      continue;
    }
    if (text.startsWith('+')) {
      if (file !== undefined && !NO_CODE.test(text.slice(1))) {
        const lines = changed.get(file) ?? [];
        lines.push(line);
        changed.set(file, lines);
      }
      line++;
    } else if (text.startsWith(' ')) line++;
  }
  return changed;
}

/** The executed count of each line per source file of an lcov report; paths are taken as the report states them. */
export function lcovLines(lcov: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let lines: Map<number, number> | undefined;
  for (const text of lcov.split('\n')) {
    if (text.startsWith('SF:')) {
      lines = new Map();
      files.set(text.slice(3).trim(), lines);
    } else if (text.startsWith('DA:') && lines !== undefined) {
      const [at, count] = text.slice(3).split(',');
      lines.set(Number(at), Number(count));
    } else if (text.startsWith('end_of_record')) lines = undefined;
  }
  return files;
}

/**
 * The coverage of the changed lines under the executed lines: a file the report lacks was never loaded, so all
 * its lines are uncovered; a line the report does not list carries no code and is not counted. Undefined when no
 * changed line counts.
 */
export function diffCoverage(
  changed: ReadonlyMap<string, readonly number[]>,
  executed: ReadonlyMap<string, ReadonlyMap<number, number>>,
): DiffCoverage | undefined {
  let covered = 0;
  let counted = 0;
  const uncovered: string[] = [];
  for (const [file, lines] of changed) {
    const report = executed.get(file);
    for (const line of lines) {
      const count = report === undefined ? 0 : report.get(line);
      if (count === undefined) continue;
      counted++;
      if (count > 0) covered++;
      else uncovered.push(`${file}:${line}`);
    }
  }
  return counted === 0 ? undefined : { covered, changed: counted, uncovered };
}

/** The proof-line part: `diff-coverage <covered>/<changed>` with the uncovered lines, or `diff-coverage n/a` with no coverage source. */
export function diffCoverageText(coverage: DiffCoverage | undefined): string {
  if (coverage === undefined) return 'diff-coverage n/a';
  const head = `diff-coverage ${coverage.covered}/${coverage.changed}`;
  if (coverage.uncovered.length === 0) return head;
  const listed = coverage.uncovered.slice(0, LISTED).join(' ');
  const more = coverage.uncovered.length - LISTED;
  return `${head} (uncovered ${listed}${more > 0 ? ` +${more} more` : ''})`;
}
