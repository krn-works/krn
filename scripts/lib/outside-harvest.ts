// What an outside row leaves behind for the brain: the records its Stop hook refused become
// proposals, and a proposal seen in two or more row repositories is promoted onto the enforced
// pack record it names. Pure: the caller reads the checkouts and writes the files.
import type { Exposure } from '../../src/brain/exposures.ts';
import { type Candidate, normalizeText } from '../../src/brain/proposals.ts';
import type { UnifiedRecord } from '../../src/brain/record.ts';

/** The records a row's Stop hook refused, once each, in log order. */
export function refusedRecords(exposures: readonly Exposure[]): string[] {
  const ids = exposures
    .filter((exposure) => exposure.channel === 'stop')
    .flatMap((exposure) =>
      Object.entries(exposure.outcome).flatMap(([id, outcome]) =>
        outcome === 'violated' ? [id] : [],
      ),
    );
  return [...new Set(ids)];
}

/** The `krn standards propose` arguments for each refused record the pack knows; others are skipped. */
export function proposeArgs(
  refused: readonly string[],
  pack: readonly Pick<UnifiedRecord, 'id' | 'text'>[],
  stack: string,
): string[][] {
  return refused.flatMap((id) => {
    const record = pack.find((entry) => entry.id === id);
    return record === undefined
      ? []
      : [
          [
            'standards',
            'propose',
            '--text',
            record.text,
            '--kind',
            'check',
            '--evidence',
            `outside:${stack}:stop:${id}`,
          ],
        ];
  });
}

/**
 * The pack with `harvested` set on every enforced record that a promotable candidate names by its
 * text. A candidate no pack record states, or one whose record is advisory, is left out: it has no
 * enforcement to promote.
 */
export function promoteCandidates(
  pack: readonly UnifiedRecord[],
  candidates: readonly Candidate[],
): { pack: UnifiedRecord[]; promoted: string[] } {
  const promoted: string[] = [];
  const next = pack.map((record) => {
    const candidate = candidates.find(
      (entry) =>
        entry.promotable &&
        normalizeText(entry.text) === normalizeText(record.text),
    );
    if (candidate === undefined || record.enforcement.kind === 'advisory')
      return record;
    const origins = [
      ...new Set([...(record.harvested?.origins ?? []), ...candidate.origins]),
    ];
    const occurrences = Math.max(
      record.harvested?.occurrences ?? 0,
      candidate.occurrences,
      origins.length,
    );
    if (
      record.harvested?.origins.length === origins.length &&
      record.harvested.occurrences === occurrences
    )
      return record;
    promoted.push(record.id);
    return { ...record, harvested: { origins, occurrences } };
  });
  return { pack: next, promoted };
}
