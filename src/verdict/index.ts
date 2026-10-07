// Verdict binds deterministic gates and review to one exact commit. ADR 0001.
import { type Job, NotImplemented } from '../core/index.ts';

export function judge(_job: Job, _sha: string): never {
  throw new NotImplemented('J1 step 5: judge the exact worker commit');
}
