// Static rule checks the edit hook runs on the text an edit writes, so a violation of a test/rules rule
// shows at the edit instead of in a late `npm run fast` rerun. Each check mirrors one rule test and is a
// pure scan of the text: no file or process access, so it stays inside the hook's latency.

const TEST_PATH = /^test\/.+\.test\.[cm]?[jt]sx?$/u;
const HYGIENE_RULE = 'test/rules/test-hygiene.test.mjs';

// Elapsed-time assertions flake on loaded runners; poll a condition under a deadline instead.
const WALL_CLOCK =
  /\b(?:Date|performance)\.now\(\)\s*-\s*[A-Za-z_$]|\bprocess\.hrtime\b/u;
// The runner's --test-timeout ceiling bounds every test.
const TEST_TIMEOUT =
  /\b(?:test|it|describe|suite)(?:\.\w+)?\(\s*(['"`])(?:(?!\1)[^\\]|\\.)*\1\s*,\s*\{[^}]*?\btimeout\s*:/gu;

/** The text an Edit, MultiEdit or Write payload puts into the file, or undefined for another tool. */
export function writtenText(
  payload: Record<string, unknown>,
): string | undefined {
  const input = payload.tool_input;
  if (typeof input !== 'object' || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  if (typeof fields.content === 'string') return fields.content;
  if (typeof fields.new_string === 'string') return fields.new_string;
  if (Array.isArray(fields.edits))
    return fields.edits
      .map((edit) =>
        typeof edit === 'object' &&
        edit !== null &&
        typeof (edit as Record<string, unknown>).new_string === 'string'
          ? (edit as Record<string, string>).new_string
          : '',
      )
      .join('\n');
  return undefined;
}

/**
 * The rule violations in `text` written to repository file `file`, as "file:line rule message" with
 * the line counted inside the written text. Only test files are checked, by the test/rules tests.
 */
export function ruleViolations(file: string, text: string): string[] {
  if (!TEST_PATH.test(file) || file === HYGIENE_RULE) return [];
  const found: string[] = [];
  text.split('\n').forEach((line, index) => {
    if (WALL_CLOCK.test(line))
      found.push(
        `${file}:${index + 1} wall-clock delta (${HYGIENE_RULE}); assert on a condition, not elapsed time`,
      );
  });
  for (const match of text.matchAll(TEST_TIMEOUT)) {
    const line = text.slice(0, match.index).split('\n').length;
    found.push(
      `${file}:${line} per-test timeout (${HYGIENE_RULE}); the runner ceiling bounds every test`,
    );
  }
  return found;
}
