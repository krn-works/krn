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

/**
 * The marker a test carries for clause `n` (1-based): `clause 2` in a test
 * name or comment, or `test_clause_2` / `testClause2` where a name cannot
 * hold a space (PHP, Python, Go methods).
 */
export function clauseMarker(n: number): RegExp {
  return new RegExp(
    `(?:(?<![A-Za-z0-9])[cC]|(?<=[a-z0-9])C)(?:lause|LAUSE)[ _-]?${n}(?!\\d)`,
    'u',
  );
}

/** Whether a commit message declares clause `n` not reproducible, with a reason. */
export function declaresNotReproducible(message: string, n: number): boolean {
  return new RegExp(
    `^\\s*clause[ _-]?${n}\\s*:\\s*not reproducible\\b.{3,}`,
    'imu',
  ).test(message);
}

/** Whether a commit message declares clause `n` not affected: a sibling call site the defect cannot reach, with a reason. */
export function declaresNotAffected(message: string, n: number): boolean {
  return new RegExp(
    `^\\s*clause[ _-]?${n}\\s*:\\s*not affected\\b.{3,}`,
    'imu',
  ).test(message);
}

/** Whether a task body describes a defect: the arm that sweeps the sibling call sites applies to it. */
export function isBugBody(body: string): boolean {
  return /\b(?:bugs?|defects?|regressions?|wrong|incorrect(?:ly)?|misbehav\w*|crash\w*)\b/iu.test(
    body,
  );
}

/** Whether a commit message declares clause `n` characterized: the behaviour already works, so its test is green at the base. */
export function declaresCharacterizes(message: string, n: number): boolean {
  return new RegExp(
    `^\\s*clause[ _-]?${n}\\s*:\\s*characterizes\\b.{3,}`,
    'imu',
  ).test(message);
}

/** The changed test files marked with a clause that a commit message declares characterized. */
export function characterizingTests(
  messages: string,
  tests: ReadonlyMap<string, string>,
): string[] {
  const declared = Array.from({ length: MAX_OWN }, (_, i) => i + 1).filter(
    (n) => declaresCharacterizes(messages, n),
  );
  return [...tests.keys()].filter((file) =>
    declared.some((n) => clauseMarker(n).test(tests.get(file) ?? '')),
  );
}

const EDGE_CASES =
  'empty input, a missing record, an unauthorised caller, a duplicate submit, non-ASCII text';

/**
 * The brief section for the acceptance-clause arm. A body with under two clauses makes the worker
 * write numbered clauses first, edge cases included, then prove each one.
 */
export function clauseSection(
  body: string,
  sweep: readonly string[] = [],
): string {
  const clauses = statedClauses(body, sweep);
  if (clauses.length === 0)
    return `Acceptance clauses (write them first):\nThe task states under 2 clauses. Before any code, write at least 3 numbered clauses ("1. ...") for what it must do, covering the stack edge cases that apply (${EDGE_CASES}). For each clause N, commit a test whose name contains "clause N" (testClauseN or test_clause_N where names cannot hold a space) that fails against the base source and passes on your commit; when a clause cannot be reproduced, put a line "Clause N: not reproducible: <reason>" in a commit message; when the behaviour already works, keep a test named "clause N" that is green at the base and put a line "Clause N: characterizes: <reason>" in a commit message. Your session is refused its end until at least 3 clauses are proven.`;
  return `Acceptance clauses (cover every one):\n${clauses.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n- For each clause N, commit a test whose name contains "clause N" (testClauseN or test_clause_N where names cannot hold a space) that fails against the base source and passes on your commit; when a clause cannot be reproduced, put a line "Clause N: not reproducible: <reason>" in a commit message; when the behaviour already works, keep a test named "clause N" that is green at the base and put a line "Clause N: characterizes: <reason>" in a commit message. Your session is refused its end while a clause is uncovered.`;
}

/**
 * The clauses a brief states: the task's own, then one per sibling call site of a defect (`sweep`),
 * so the Stop hook and the proof line demand each of them. Under two clauses in all, there are none.
 */
export function statedClauses(
  body: string,
  sweep: readonly string[] = [],
): string[] {
  const all = [...splitClauses(body), ...sweep];
  return all.length >= 2 ? all : [];
}

/** The most clause numbers a worker-written list can carry. */
const MAX_OWN = 30;

export type ClauseProof = {
  /** The clause number as the brief or the worker numbered it. */
  n: number;
  /** The clause text; a worker-written clause has no text of its own. */
  text: string;
  proven: boolean;
  /** A changed test file marked with the clause that passes on head, else undefined. */
  test?: string;
  /** The commit message declares the clause not reproducible, or its call site not affected. */
  declared: boolean;
};

export type ClauseProofResult = {
  /** The task states under two clauses, so the worker's own marked numbers are the clauses. */
  own: boolean;
  clauses: ClauseProof[];
};

/**
 * The one reader of clause proof, for the Stop hook and the lane run's proof line. A clause is proven by
 * a changed test file marked `clause N` that passes on head, or by a `Clause N: not reproducible: <reason>`
 * commit line. Red at the base is not asked per clause: the test-first arm asks it once for the change.
 * `stated` holds the task's clause texts (empty when the worker writes its own); `tests` maps each changed
 * test file to its text; `headFailing` names the changed test files that fail on head.
 */
export function clauseProof(input: {
  stated: readonly string[];
  tests: ReadonlyMap<string, string>;
  messages: string;
  headFailing?: ReadonlySet<string>;
}): ClauseProofResult {
  const own = input.stated.length === 0;
  const marked = (n: number) =>
    [...input.tests].filter(([, text]) => clauseMarker(n).test(text));
  const excused = (n: number) =>
    declaresNotReproducible(input.messages, n) ||
    declaresNotAffected(input.messages, n);
  const covered = (n: number) => marked(n).length > 0 || excused(n);
  const numbers = own
    ? Array.from({ length: MAX_OWN }, (_, i) => i + 1).filter(covered)
    : input.stated.map((_, i) => i + 1);
  const clauses = numbers.map((n, i): ClauseProof => {
    const declared = excused(n);
    const test = marked(n)
      .map(([file]) => file)
      .find((file) => !input.headFailing?.has(file));
    return {
      n,
      text: own ? '' : (input.stated[i] ?? ''),
      declared,
      ...(test === undefined ? {} : { test }),
      proven: declared || test !== undefined,
    };
  });
  return { own, clauses };
}

/** The changed test files that carry a clause marker: the files whose head result the reader needs. */
export function markedTests(
  stated: readonly string[],
  tests: ReadonlyMap<string, string>,
): string[] {
  const own = stated.length === 0;
  const numbers = own
    ? Array.from({ length: MAX_OWN }, (_, i) => i + 1)
    : stated.map((_, i) => i + 1);
  return [...tests.keys()].filter((file) =>
    numbers.some((n) => clauseMarker(n).test(tests.get(file) ?? '')),
  );
}

/** The pre-existing test layout: `test/**.test.<ext>`. */
export const LEGACY_TEST = /^test\/.+\.test\.(?:ts|js|mjs|cjs)$/u;

/** The path shapes of test files, shared by the Stop hook and the lane run. */
export const TEST_FILE = [
  LEGACY_TEST,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
  /(?:^|\/)test_[^/]+\.py$/u,
  /_test\.(?:py|go)$/u,
  /_spec\.rb$/u,
  /Test\.php$/u,
  // A runner script directly under test/ or tests/ (tests/run.php, the
  // repository's own harness) is a test file in any language.
  /(?:^|\/)tests?\/[^/]+\.(?:[cm]?js|php|py|rs)$/u,
];

export const isTestFile = (path: string) => TEST_FILE.some((p) => p.test(path));
