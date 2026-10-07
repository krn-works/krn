// Hosts starts and cancels worker processes through the selected host. ADR 0001.
import { type Job, NotImplemented } from '../core/index.ts';

export function start(_job: Job): never {
  throw new NotImplemented('J1 step 2: start the Codex worker');
}
