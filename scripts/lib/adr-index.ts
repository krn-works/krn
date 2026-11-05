// Checks docs/adr/README.md against the ADR files it indexes. Pure: text in,
// findings out. Contract (the shapes caught, each with a fixture in
// test/rules/adr-index.test.ts): an index range `D<a>–D<b>` or an ADR Status
// range that differs from the ADR's decision-table rows `| D<n> |`, ids that
// are not contiguous, an index status that is not a whole-word prefix of the
// ADR's first Status paragraph, and index rows and ADR files that do not pair
// one to one. Full Markdown parsing is a non-goal; an index table row or ADR
// the scanner cannot classify is a finding, so the check fails closed.

export interface AdrFile {
  readonly file: string;
  readonly text: string;
}

const normalise = (text: string): string =>
  text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');

const ROW =
  /^\| \[(\d{4})\]\((\d{4})(-[^)\s/]+\.md)\) \| ([^|]+?) \| (.*?) \|$/u;
const RANGE = /\bD(\d+)[–-]D(\d+)\b/gu;
const DECISION = /^\| D(\d+) \|/u;

interface IndexRow {
  readonly label: string;
  readonly file: string;
  readonly status: string;
  readonly decision: string;
}

const statusParagraph = (text: string): string | undefined => {
  const lines = normalise(text).split('\n');
  const start = lines.findIndex((line) => /^ {0,3}## Status\s*$/u.test(line));
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      if (body.length > 0) break;
      continue;
    }
    if (/^ {0,3}#/u.test(line)) break;
    body.push(line.trim());
  }
  return body.length > 0 ? body.join(' ') : undefined;
};

const ranges = (text: string): string[] =>
  [...text.matchAll(RANGE)].map((m) => `D${m[1]}–D${m[2]}`);

const decisionIds = (text: string): number[] =>
  normalise(text)
    .split('\n')
    .flatMap((line) => {
      const m = DECISION.exec(line);
      return m ? [Number(m[1])] : [];
    });

const words = (text: string): string =>
  text.toLowerCase().replace(/\s+/gu, ' ').trim();

// Only the ADR text drops its `ADR ` markers ("Superseded by ADR 0014 D8"
// is indexed as "superseded by 0014 D8"); the index status is taken as is.
const isPrefix = (status: string, paragraph: string): boolean => {
  const want = words(status);
  const have = words(paragraph.replace(/\bADR /gu, ''));
  return (
    want !== '' &&
    have.startsWith(want) &&
    !/[\p{L}\p{N}]/u.test(have.charAt(want.length))
  );
};

const parseIndex = (
  index: string,
): { rows: IndexRow[]; findings: string[] } => {
  const rows: IndexRow[] = [];
  const findings: string[] = [];
  for (const line of normalise(index).split('\n')) {
    // Indented rows are classified too, so they can never be skipped.
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (/^\| ADR \| Status \| Decision \|$/u.test(trimmed)) continue;
    if (/^\|[-:| ]+\|$/u.test(trimmed)) continue;
    const m = ROW.exec(trimmed);
    if (!m) {
      findings.push(`unrecognised index row: ${trimmed.slice(0, 120)}`);
      continue;
    }
    const [, label = '', number = '', rest = '', status = '', decision = ''] =
      m;
    if (label !== number) {
      findings.push(`index row ${label} links ${number}${rest}`);
    }
    rows.push({ label, file: `${number}${rest}`, status, decision });
  }
  return { rows, findings };
};

const checkRange = (
  label: string,
  where: string,
  stated: readonly string[],
  ids: readonly number[],
): string[] => {
  if (stated.length === 0) return [];
  if (ids.length === 0) {
    return [
      `${label} ${where} states ${stated.join(', ')} but has no decision table`,
    ];
  }
  const actual = `D${Math.min(...ids)}–D${Math.max(...ids)}`;
  return stated
    .filter((range) => range !== actual)
    .map(
      (range) =>
        `${label} ${where} states ${range}; decision table holds ${actual}`,
    );
};

export const checkAdrIndex = (
  index: string,
  adrs: readonly AdrFile[],
): string[] => {
  const { rows, findings } = parseIndex(index);
  const byFile = new Map(adrs.map((adr) => [adr.file, adr.text]));
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(row.file, (seen.get(row.file) ?? 0) + 1);
  for (const [file, count] of seen) {
    if (count > 1) findings.push(`${file} has more than one index row`);
  }
  for (const adr of adrs) {
    if (!seen.has(adr.file)) findings.push(`${adr.file} has no index row`);
  }
  for (const row of rows) {
    const text = byFile.get(row.file);
    if (text === undefined) {
      findings.push(
        `index row ${row.label} links ${row.file}, which has no ADR file`,
      );
      continue;
    }
    const paragraph = statusParagraph(text);
    if (paragraph === undefined) {
      findings.push(`${row.label} has no Status section`);
    } else if (!isPrefix(row.status, paragraph)) {
      findings.push(
        `${row.label} index status "${row.status}" does not match Status "${paragraph.slice(0, 120)}"`,
      );
    }
    const ids = decisionIds(text);
    const sorted = [...ids].sort((a, b) => a - b);
    if (sorted.some((id, i) => id !== (sorted[0] ?? 0) + i)) {
      findings.push(`${row.label} decision ids are not contiguous`);
    }
    findings.push(
      ...checkRange(row.label, 'index', ranges(row.decision), ids),
      ...checkRange(row.label, 'Status', ranges(paragraph ?? ''), ids),
    );
  }
  return findings;
};
