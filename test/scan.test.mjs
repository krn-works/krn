import test from "node:test";
import assert from "node:assert/strict";
import { scanAll } from "../src/ledger/scan.ts";

test("scanAll pages through a history longer than one page", () => {
  const total = 2500;
  const ledger = {
    scan: ({ afterSeq = 0, limit }) =>
      Array.from({ length: Math.max(0, Math.min(limit, total - afterSeq)) }, (_, i) => ({ seq: afterSeq + i + 1 })),
  };
  const events = scanAll(ledger, "x");
  assert.equal(events.length, total);
  assert.equal(events[total - 1].seq, total);
});
