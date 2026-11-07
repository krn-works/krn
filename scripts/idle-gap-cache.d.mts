export type Record =
  | {
      kind: 'compact';
      ts: number;
      trigger?: string;
      pre?: number;
      post?: number;
    }
  | {
      kind: 'turn';
      ts: number;
      id?: string;
      write: number;
      read: number;
      fresh: number;
    }
  | { kind: 'msg'; ts: number };
export function parseLine(line: string): Record | null;
export function analyze(
  records: (Record | null)[],
  ttlSec: number,
): {
  turns: number;
  write: number;
  read: number;
  gaps: number;
  gapWrite: number;
  gapCtx: number;
  compacts: number;
  compactAuto: number;
  compactPost: number;
};
