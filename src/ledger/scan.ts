import type { EventLedger, EventRecord } from "./types.js";

/** Read all events of one kind without silently truncating a long history. */
export function scanAll(ledger: Pick<EventLedger, "scan">, kind: EventRecord["kind"]): readonly EventRecord[] {
  const events: EventRecord[] = [];
  let afterSeq: number | undefined;
  for (;;) {
    const page = ledger.scan({ kind, ...(afterSeq === undefined ? {} : { afterSeq }), limit: 1000 });
    if (page.length === 0) return events;
    events.push(...page);
    const last = page[page.length - 1]!;
    if (page.length < 1000) return events;
    afterSeq = last.seq;
  }
}
