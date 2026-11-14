// The one record schema of the brain: a standard, a convention, a pitfall or a recipe, whether it
// ships in the pack (standards/records.json) or lives in a repository's overlay (.agents/records.json).
// The plainest hand-written row (id, type, text, three dates, source) is the shortest accepted form;
// every other field has a default, and `source` is shorthand for provenance.origin.
import { z } from 'zod';
import type { Standard } from './standards.ts';

export const RECORD_TYPES = [
  'standard',
  'convention',
  'pitfall',
  'recipe',
] as const;
export const RECORD_STATUSES = ['trial', 'accepted', 'retired'] as const;
export const RECORD_AUDIENCES = ['all', 'worker', 'lead', 'adopt'] as const;
export const RECORD_TIERS = ['floor', 'reflex', 'finish'] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const date = z.string().regex(DATE, 'expected YYYY-MM-DD');
const words = z.string().min(1, 'expected text');
const list = z.array(words).default([]);

const enforcement = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('advisory') }),
  z.strictObject({ kind: z.literal('command'), run: words }),
  z.strictObject({ kind: z.literal('krn'), args: z.array(words).min(1) }),
]);

const ALIASES: Readonly<Record<string, string>> = {
  rule: 'standard',
  lesson: 'pitfall',
};

/** The legacy `source` string is the origin; legacy types `rule` and `lesson` are standard and pitfall. */
function shorthand(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return input;
  const { source, ...rest } = input as Record<string, unknown>;
  const type = typeof rest.type === 'string' ? ALIASES[rest.type] : undefined;
  const provenance =
    source === undefined
      ? rest.provenance
      : rest.provenance === undefined
        ? { origin: source }
        : rest.provenance;
  return {
    ...rest,
    ...(type === undefined ? {} : { type }),
    ...(provenance === undefined ? {} : { provenance }),
  };
}

export const RecordSchema = z.preprocess(
  shorthand,
  z
    .strictObject({
      id: words,
      type: z.enum(RECORD_TYPES),
      text: words,
      why: z.string().default(''),
      audience: z.enum(RECORD_AUDIENCES).default('all'),
      tier: z.enum(RECORD_TIERS).default('reflex'),
      applies: z
        .strictObject({
          stacks: list,
          needs: list,
          paths: list,
          terms: list,
        })
        .default({ stacks: [], needs: [], paths: [], terms: [] }),
      enforcement: enforcement.default({ kind: 'advisory' }),
      provenance: z.strictObject({
        origin: words,
        evidence: list,
        proposals: list,
      }),
      status: z.enum(RECORD_STATUSES).default('accepted'),
      recorded_at: date,
      valid_from: date,
      valid_to: date.nullable(),
      supersedes: list,
      /** True only for a record that holds in any repository and any stack; the global file renders exactly these. */
      universal: z.literal(true).optional(),
    })
    .refine((r) => r.valid_to === null || r.valid_to >= r.valid_from, {
      message: 'valid_to precedes valid_from',
    }),
);

export type UnifiedRecord = z.output<typeof RecordSchema>;

/** Every record of a JSON array, with unique ids; one error line names the first bad row. */
export function parseUnified(value: unknown): UnifiedRecord[] {
  if (!Array.isArray(value)) throw new Error('records: expected a JSON array');
  const seen = new Set<string>();
  return value.map((item: unknown, index) => {
    const parsed = RecordSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = (issue?.path ?? []).join('.');
      throw new Error(
        `records[${index}]${path === '' ? '' : `.${path}`}: ${issue?.message ?? 'invalid'}`,
      );
    }
    if (seen.has(parsed.data.id))
      throw new Error(`records[${index}]: duplicate id ${parsed.data.id}`);
    seen.add(parsed.data.id);
    return parsed.data;
  });
}

/** A standards-pack record in the unified shape; a universal one holds in every stack. */
export function standardRecord(s: Standard): UnifiedRecord {
  const universal = s.layer === 'universal' && s.applies.stacks.length === 0;
  return {
    id: s.id,
    type: 'standard',
    text: s.text,
    why: s.why,
    audience: s.audience,
    tier: s.tier,
    applies: {
      stacks: [...s.applies.stacks],
      needs: [...s.applies.needs],
      paths: [],
      terms: [],
    },
    enforcement:
      s.enforcement.kind === 'krn'
        ? { kind: 'krn', args: [...s.enforcement.args] }
        : s.enforcement,
    provenance: {
      origin: s.origin === undefined ? 'krn pack' : 'krn pack (inherited)',
      evidence: [...s.evidence],
      proposals: [],
    },
    status: s.valid_to === null ? 'accepted' : 'retired',
    recorded_at: s.recorded_at,
    valid_from: s.valid_from,
    valid_to: s.valid_to,
    supersedes: [],
    ...(universal ? { universal: true as const } : {}),
  };
}
