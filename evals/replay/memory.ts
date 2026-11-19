// Arm C remembers (ADR 0021 point 10): units of one repository run in commit-date order, and a graded failure of an
// earlier unit proposes one evidence-gated trial record through the S15 path (src/brain/evidence-proposals.ts). Arm C serves
// those records and arm B carries them statically; arm A never sees them.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type EvidenceProposal,
  evidenceProposals,
  trialRecord,
  writeTrialRecords,
} from '../../src/brain/evidence-proposals.ts';
import { EXPOSURE_SCHEMA, type Exposure } from '../../src/brain/exposures.ts';
import { type BrainRecord, parseRecords } from '../../src/brain/packet.ts';
import { contractConventions } from '../../src/repo/contract.ts';
import type { LiveUnit } from './live.ts';
import type { Row } from './rows.ts';
import type { ScreenUnit } from './screen.ts';

const committed = ({ unit }: LiveUnit): string =>
  (unit as ScreenUnit).committed ?? '';

/** Units grouped by repository, each repository's units oldest commit first (ties by id). */
export function commitDateOrder(units: readonly LiveUnit[]): LiveUnit[] {
  return [...units].sort(
    (a, b) =>
      a.unit.repo.localeCompare(b.unit.repo) ||
      committed(a).localeCompare(committed(b)) ||
      a.unit.id.localeCompare(b.unit.id),
  );
}

/** The close exposure a graded hidden-test failure of the unit is: the row the S15 reader takes. */
const failureExposure = (unit: string, at: string): Exposure => ({
  schema: EXPOSURE_SCHEMA,
  at,
  run: `replay-${unit}`,
  task: unit,
  channel: 'close',
  attempt: 1,
  served: [],
  withheld: [],
  tokens: 0,
  violated: {},
  outcome: {},
  lane_ok: false,
  evidence: { pr: null, ci: null, hidden: 'fail' },
});

/** What arm C has learned so far, by repository. */
export class RepoMemory {
  private readonly byRepo = new Map<string, EvidenceProposal[]>();

  /** The proposals earlier units of `repo` left, to seed arm C's checkout with. */
  forRepo(repo: string): readonly EvidenceProposal[] {
    return this.byRepo.get(repo) ?? [];
  }

  /** Records a graded failure (`pass === false`) of arm C on `unit`; a pass, an ungraded row or another arm teaches nothing. */
  learn(unit: LiveUnit, row: Row, asOf: string): void {
    if (row.arm !== 'C' || row.pass !== false) return;
    const proposals = evidenceProposals(
      {
        ci: [],
        exposures: [failureExposure(unit.unit.id, asOf)],
        reviews: [],
        inbox: [],
        dispositions: [],
      },
      new Map(),
      asOf,
    );
    const have = this.byRepo.get(unit.unit.repo) ?? [];
    this.byRepo.set(unit.unit.repo, [...have, ...proposals]);
  }
}

/** The remembered proposals as the records a packet serves. */
export const memoryRecords = (
  proposals: readonly EvidenceProposal[],
): BrainRecord[] => parseRecords(proposals.map(trialRecord));

/**
 * Writes the remembered proposals as trial records into the conventions file the checkout's contract names (the default
 * when it declares none), the file the lane packet reads; call it before adoption, which leaves that file alone.
 */
export function seedMemory(
  wt: string,
  proposals: readonly EvidenceProposal[],
): number {
  if (proposals.length === 0) return 0;
  const file = contractConventions(wt);
  mkdirSync(dirname(`${wt}/${file}`), { recursive: true });
  return writeTrialRecords(wt, proposals, file);
}
