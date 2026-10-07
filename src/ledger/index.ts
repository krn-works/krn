// Ledger reads and submits work through the Paperclip authority. ADR 0001.
import { type Job, NotImplemented } from '../core/index.ts';

export function readContract(_job: Job): never {
  throw new NotImplemented('J1 step 1: read the Paperclip contract');
}
