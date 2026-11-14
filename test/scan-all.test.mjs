import test from "node:test";
import assert from "node:assert/strict";
import { scanAll } from "../src/ledger/scan.ts";

function fakeLedger(total) {
  const calls = [];
  return {
    calls,
    scan(query) {
      calls.push(query);
      const start = query.afterSeq ?? 0;
      const page = [];
      for (let seq = start + 1; seq <= total && page.length < query.limit; seq++) page.push({ seq, kind: query.kind });
      return page;
    },
  };
}

test("scanAll returns an empty list for an empty ledger", () => {
  assert.deepEqual(scanAll(fakeLedger(0), "x"), []);
});

test("scanAll pages past 1000 events without truncating", () => {
  const ledger = fakeLedger(2500);
  const events = scanAll(ledger, "x");
  assert.equal(events.length, 2500);
  assert.equal(events[2499].seq, 2500);
  assert.deepEqual(ledger.calls.map((c) => c.afterSeq), [undefined, 1000, 2000]);
});
