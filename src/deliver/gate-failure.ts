// Names the cause of a failed krn/gate check run from its GitHub output, also
// when a deployed Jenkins library predates stage summaries (t-axrzg1n).

const causeLimit = 300;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// One printable line: cut at the first line break (LF, CR, U+2028, U+2029) and
// drop control and format characters (Cc, Cf: C0/C1, bidi, zero-width), so a
// check run cannot break the line or drive the terminal.
function oneLine(value: string): string {
  return (value.split(/[\n\r\p{Zl}\p{Zp}]/u)[0] ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, causeLimit);
}

export function gateFailureLine(output: unknown): string {
  const fields =
    typeof output === 'object' && output !== null
      ? (output as Record<string, unknown>)
      : {};
  const staged = /failed at stage ([^:;\n]+): ([^;\n]+)/u.exec(
    text(fields.summary) ?? '',
  );
  if (staged?.[1] && staged[2])
    return `failed at stage ${oneLine(staged[1])}: ${oneLine(staged[2])}`;
  const primary = /^Primary: (.+)$/mu.exec(text(fields.text) ?? '')?.[1];
  const cause = primary === undefined ? '' : oneLine(primary);
  if (cause !== '')
    return `failed at stage unknown: ${cause}; the deployed Jenkins library predates stage summaries, repin library_sha`;
  return 'failed at stage unknown: the check run names no stage and no primary cause';
}
