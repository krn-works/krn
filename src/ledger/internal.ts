import type { EventLedger } from "./types.js";

const rawByteLimits = new WeakMap<object, number>();

export function registerRawByteLimit(ledger: EventLedger, limit: number): void {
  rawByteLimits.set(ledger, limit);
  // A shallow decorator commonly copies the archive method while replacing a
  // different ledger method. Keep the internal budget discoverable through
  // that stable function identity without exposing it on the public type.
  rawByteLimits.set(ledger.archive, limit);
}

export function rawByteLimitFor(ledger: EventLedger): number | undefined {
  return rawByteLimits.get(ledger) ?? rawByteLimits.get(ledger.archive);
}
