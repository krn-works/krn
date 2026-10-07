// Memory starts with capsule and document pointers; event storage is conditional. ADR 0001.
import { type Job, NotImplemented } from '../core/index.ts';

export function loadPointers(_job: Job): never {
  throw new NotImplemented('J1 step 2: load memory pointers');
}
