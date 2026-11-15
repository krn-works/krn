import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLedger, type EventLedger } from "../../src/ledger/index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { ledger: EventLedger; databasePath: string; blobs: string } {
  const root = mkdtempSync(join(tmpdir(), "ledger-transaction-test-"));
  roots.push(root);
  const databasePath = join(root, "ledger.sqlite");
  const blobs = join(root, "blobs");
  return {
    databasePath,
    blobs,
    ledger: openLedger({ databasePath, blobDirectory: blobs, projectId: "project", maxRawBytesPerExecution: 64 * 1024 * 1024 }),
  };
}

function append(ledger: EventLedger, eventId: string) {
  return ledger.append({
    eventId,
    sessionId: "session",
    correlationId: "correlation",
    kind: "guard_decision",
    sourceTimestamp: "2026-09-07T20:00:00.000Z",
    payload: { eventId },
    blobs: [],
  });
}

describe("EventLedger.transactionImmediate", () => {
  it("rolls back projection writes and append together when fn throws", () => {
    const { ledger } = fixture();
    ledger.transactionImmediate(db => { db.exec("CREATE TABLE projection_test(id TEXT PRIMARY KEY)"); });

    expect(() => ledger.transactionImmediate(db => {
      db.prepare("INSERT INTO projection_test(id) VALUES (?)").run("row-1");
      append(ledger, "rolled-back-event");
      throw new Error("rollback");
    })).toThrow(/rollback/);

    expect(ledger.getEvent("rolled-back-event")).toBeUndefined();
    const count = ledger.transactionImmediate(db => db.prepare("SELECT COUNT(*) AS count FROM projection_test").get() as { count: number });
    expect(count.count).toBe(0);
    ledger.close();
  });

  it("commits append inside transactionImmediate and preserves it after reopen", () => {
    const { ledger, databasePath, blobs } = fixture();
    ledger.transactionImmediate(() => { append(ledger, "transaction-event"); });
    expect(ledger.getEvent("transaction-event")?.event_id).toBe("transaction-event");
    ledger.close();

    const reopened = openLedger({ databasePath, blobDirectory: blobs, projectId: "project", maxRawBytesPerExecution: 64 * 1024 * 1024 });
    expect(reopened.getEvent("transaction-event")?.event_id).toBe("transaction-event");
    reopened.close();
  });

  it("maintains hash-chain order for events appended inside the transaction", () => {
    const { ledger } = fixture();
    const first = append(ledger, "before");
    let second = first;
    let third = first;
    ledger.transactionImmediate(() => {
      second = append(ledger, "inside-1");
      third = append(ledger, "inside-2");
    });
    expect(second.previous_event_hash).toBe(first.event_hash);
    expect(third.previous_event_hash).toBe(second.event_hash);
    expect(ledger.scan({ limit: 10 }).map(event => event.event_id)).toEqual(["before", "inside-1", "inside-2"]);
    ledger.close();
  });
});
