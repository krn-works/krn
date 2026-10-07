// Foreman owns the bounded J1 session loop. ADR 0001.
import { type Job, NotImplemented } from '../core/index.ts';

export function runJob(_job: Job): never {
  throw new NotImplemented('J1 step 2: supervise a fresh worker session');
}
