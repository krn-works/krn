// The standards index: one line per enforced record of the shipped pack, generated so an agent
// knows every rule up front. The same bytes ship to every adopted repository through the standards
// skill, so the index depends on the pack alone, never on a date or a repository.
import type { Standard } from './standards.ts';

/** The index stays under this many bytes. */
export const INDEX_BUDGET_BYTES = 6000;

const HEADER = [
  '# Standards index',
  '',
  'Generated from standards/records.json by `node scripts/render-standards-index.ts --write`; do not edit.',
  'One line per enforced record: `id [first path scope +others]: rule`. Each is checked by `krn standards check --record <id>`.',
  'Ask `krn standards query "<what you do>" --file <path>` for the full text and the reason.',
  '',
].join('\n');

/** The accepted, unexpired pack records that run a check. */
export function enforcedRecords(pack: readonly Standard[]): Standard[] {
  return pack.filter(
    (record) =>
      record.enforcement.kind !== 'advisory' &&
      record.status === 'accepted' &&
      record.valid_to === null,
  );
}

function scope(record: Standard): string {
  const paths = record.applies.paths;
  const [first] = paths;
  if (first === undefined) return '';
  return ` [${first}${paths.length > 1 ? `+${paths.length - 1}` : ''}]`;
}

/** The first sentence of the rule, without its closing full stop. */
function firstSentence(text: string): string {
  const match = /^.*?[.;:](?=\s|$)/su.exec(text.trim());
  return (match?.[0] ?? text).replace(/[.;:]$/u, '').replace(/\s+/gu, ' ');
}

function clip(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(`${text.slice(0, end)}...`) > max) end--;
  return `${text.slice(0, end).trimEnd()}...`;
}

/** The index of the enforced pack records: every record keeps a line, rules are cut to fit the budget. */
export function renderStandardsIndex(pack: readonly Standard[]): string {
  const records = enforcedRecords(pack);
  const heads = records.map((record) => `${record.id}${scope(record)}: `);
  const room =
    INDEX_BUDGET_BYTES -
    Buffer.byteLength(HEADER) -
    heads.reduce((sum, head) => sum + Buffer.byteLength(head) + 1, 0) -
    64;
  const rules = records.map((record) => firstSentence(record.text));
  // Shorten the longest rules first until the lines fit the budget.
  let limit = Math.max(...rules.map((rule) => Buffer.byteLength(rule)), 0);
  const total = (cap: number) =>
    rules.reduce(
      (sum, rule) => sum + Math.min(Buffer.byteLength(rule), cap),
      0,
    );
  while (limit > 16 && total(limit) > room) limit--;
  const lines = records.map(
    (_, index) => `${heads[index]}${clip(rules[index] ?? '', limit)}`,
  );
  return `${HEADER}${lines.join('\n')}\n`;
}
