// The replay arms are configuration: each names how the unit's workspace is prepared, nothing else.
// A: plain clone. B: the in-force records rendered to a static CLAUDE.md, token-matched to C's injection.
// C: KRN (hooks, brain packet, skills).
export type ArmId = 'A' | 'B' | 'C';

export interface Arm {
  id: ArmId;
  describe: string;
  /** Static instruction file rendered from the in-force records. */
  staticRecords: boolean;
  /** KRN hooks and brain injection active in the session. */
  krn: boolean;
}

export const ARMS: Readonly<Record<ArmId, Arm>> = {
  A: { id: 'A', describe: 'plain clone', staticRecords: false, krn: false },
  B: {
    id: 'B',
    describe: 'in-force records as a static CLAUDE.md, token-matched',
    staticRecords: true,
    krn: false,
  },
  C: { id: 'C', describe: 'KRN', staticRecords: false, krn: true },
};

export function parseArms(list: string): Arm[] {
  return list.split(',').map((raw) => {
    const id = raw.trim() as ArmId;
    const arm = ARMS[id];
    if (!arm) throw new Error(`unknown arm: ${raw}`);
    return arm;
  });
}
