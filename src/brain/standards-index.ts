// The standards index: one line per enforced record of the shipped pack (and, in a second file, of
// the repository's own records), generated so an agent knows every rule up front. The same bytes ship to every adopted repository through the standards
// skill, so the index depends on the pack alone, never on a date or a repository.
import type { Standard } from './standards.ts';

/** The pack index stays under this many bytes. */
export const INDEX_BUDGET_BYTES = 12400;
/** The index of a repository's own records stays under this many bytes. */
export const OWN_INDEX_BUDGET_BYTES = 5800;

const PACK_HEADER = [
  '# Standards index',
  '',
  'Generated from standards/records.json by `node scripts/render-standards-index.ts --write`; do not edit.',
  'One line per enforced record: `id [first path scope +others]: rule`. Each is checked by `krn standards check --record <id>`.',
  'Ask `krn standards query "<what you do>" --file <path>` for the full text and the reason.',
  '',
].join('\n');

const OWN_HEADER = [
  '# Own standards index',
  '',
  'Generated from .agents/standards.json by `node scripts/render-standards-index.ts --write`; do not edit.',
  "The repository's own enforced records, beside the pack index: `id [first path scope +others]: rule`. Each is checked by `krn standards check --record <id>`.",
  '',
].join('\n');

export type IndexKind = 'pack' | 'own';
const KINDS = {
  pack: { header: PACK_HEADER, budget: INDEX_BUDGET_BYTES },
  own: { header: OWN_HEADER, budget: OWN_INDEX_BUDGET_BYTES },
} as const;

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

/** The first sentence of the rule, whole, without its closing full stop. */
function firstSentence(text: string): string {
  const flat = text.trim().replace(/\s+/gu, ' ');
  const match = /^.*?\.(?=\s|$)/su.exec(flat);
  return (match?.[0] ?? flat).replace(/\.$/u, '');
}

/** The index of the enforced records of `pack`: one line per record, every rule a whole sentence; throws over `budget` bytes. */
export function renderStandardsIndex(
  pack: readonly Standard[],
  kind: IndexKind = 'pack',
): string {
  const { header, budget } = KINDS[kind];
  const lines = enforcedRecords(pack).map(
    (record) => `${record.id}${scope(record)}: ${firstSentence(record.text)}`,
  );
  const index = `${header}${lines.join('\n')}\n`;
  if (Buffer.byteLength(index) > budget)
    throw new Error(
      `the ${kind} standards index is ${Buffer.byteLength(index)} bytes, over its ${budget} byte budget`,
    );
  return index;
}
