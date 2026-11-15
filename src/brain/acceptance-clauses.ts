/** Smallest piece of a task body worth its own test. */
const MIN_CLAUSE = 12;

/**
 * The acceptance clauses of a task body: numbered items ("(1) ...", "2) ...", "3. ..."), else
 * bullet lines, else sentences and semicolon-separated parts. A body with fewer than two clauses
 * has none: there is nothing to cover one by one.
 */
export function splitClauses(body: string): string[] {
  const text = body.replace(/\r\n?/gu, '\n').trim();
  const numbered = text
    .split(/(?:^|\s)\(?\d{1,2}[.)]\s+/u)
    .slice(1)
    .map(clean);
  const picked =
    numbered.length >= 2
      ? numbered
      : bullets(text).length >= 2
        ? bullets(text)
        : text.split(/(?<=[.;])\s+/u).map(clean);
  const clauses = picked.filter((part) => part.length >= MIN_CLAUSE);
  return clauses.length >= 2 ? clauses : [];
}

function bullets(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^\s*[-*]\s+/u.test(line))
    .map((line) => clean(line.replace(/^\s*[-*]\s+/u, '')));
}

function clean(part: string): string {
  return part.replace(/\s+/gu, ' ').trim();
}

/** The marker a test carries for clause `n` (1-based): `clause 2` in a test name or comment. */
export function clauseMarker(n: number): RegExp {
  return new RegExp(`\\bclause[ _-]?${n}\\b(?!\\d)`, 'iu');
}

/** Whether a commit message declares clause `n` not reproducible, with a reason. */
export function declaresNotReproducible(message: string, n: number): boolean {
  return new RegExp(
    `^\\s*clause[ _-]?${n}\\s*:\\s*not reproducible\\b.{3,}`,
    'imu',
  ).test(message);
}

const EDGE_CASES =
  'empty input, a missing record, an unauthorised caller, a duplicate submit, non-ASCII text';

/**
 * The brief section for the acceptance-clause arm. A body with under two clauses makes the worker
 * write numbered clauses first, edge cases included, then prove each one.
 */
export function clauseSection(body: string): string {
  const clauses = splitClauses(body);
  if (clauses.length === 0)
    return `Acceptance clauses (write them first):\nThe task states under 2 clauses. Before any code, write at least 3 numbered clauses ("1. ...") for what it must do, covering the stack edge cases that apply (${EDGE_CASES}). For each clause N, commit a test whose name contains "clause N" that fails against the base source and passes on your commit; when a clause cannot be reproduced, put a line "Clause N: not reproducible: <reason>" in a commit message. Your session is refused its end until at least 3 clauses are proven.`;
  return `Acceptance clauses (cover every one):\n${clauses.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n- For each clause N, commit a test whose name contains "clause N" that fails against the base source and passes on your commit; when a clause cannot be reproduced, put a line "Clause N: not reproducible: <reason>" in a commit message. Your session is refused its end while a clause is uncovered.`;
}
