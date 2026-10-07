// CLI owns command dispatch and the temporary legacy forwarding seam. ADR 0001.
import { NotImplemented } from '../core/index.ts';

export function dispatch(_args: string[]): never {
  throw new NotImplemented('J1 step 0: dispatch a migrated command');
}
