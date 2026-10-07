// Trace records reproducible journey events without owning job status. ADR 0001.
import { type Job, NotImplemented } from '../core/index.ts';

export function log(_job: Job, _event: string): never {
  throw new NotImplemented('J1 step 6: persist a journey event');
}
