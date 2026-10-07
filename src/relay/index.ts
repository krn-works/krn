// Relay owns the J1 continuation capsule and handoff surface. ADR 0001.
import { type Job, NotImplemented } from '../core/index.ts';

export function load(_job: Job): never {
  throw new NotImplemented('J1 step 2: load the continuation capsule');
}
