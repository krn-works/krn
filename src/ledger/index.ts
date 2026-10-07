// Ledger reads and submits work through the Paperclip authority. ADR 0001.
import { type Job, NotImplemented } from '../core/index.ts';
import type { PaperclipIssue } from '../core/paperclip.ts';

// Paperclip status is projected for reads and is never stored on Job. ADR 0001.
export type BoardView = Readonly<{
  issue: PaperclipIssue;
  status: string;
  revision: string;
  observedAt: string;
  stale: boolean;
}>;

export function readContract(_job: Job): never {
  throw new NotImplemented('J1 step 1: read the Paperclip contract');
}
