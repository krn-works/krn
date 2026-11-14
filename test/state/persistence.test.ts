import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { computeStateEpoch } from "../../src/state/index.js";
import { fixture, memory, request } from "./fixture.js";

interface Database {
  exec(sql: string): void;
  prepare(sql: string): { get(): unknown };
  close(): void;
}
const Database = createRequire(import.meta.url)("better-sqlite3") as { new(path: string): Database };

test("standalone computeStateEpoch does not require an open ledger and writes no state event", async () => {
  const f = await fixture();
  f.ledger.close();
  const epoch = await computeStateEpoch(f.input);
  expect(epoch.completeness).toBe("verified");
  const reopened = f.open();
  expect(reopened.scan({ kind: "state_epoch", limit: 100 })).toEqual([]);
});

test("instance observation has the complete payload and construction context, durable after reopen", async () => {
  const f = await fixture();
  const epoch = await f.twin.computeStateEpoch(f.input);
  const events = f.ledger.scan({ kind: "state_epoch", limit: 100 });
  expect(events).toHaveLength(1);
  const event = events[0]!;
  expect(event.payload).toEqual(epoch);
  expect(event.session_id).toBe("state-session");
  expect(event.correlation_id).toBe("state-correlation");
  expect(event.source_timestamp).toBe(epoch.created_at);
  expect(event.raw_blob_hashes).toEqual([]);
  expect(event.capture_status).toBe("not_applicable");
  f.ledger.close();
  const reopened = f.open();
  expect(reopened.scan({ kind: "state_epoch", limit: 100 })).toEqual(events);
  expect(reopened.getEvent(event.event_id)?.payload).toEqual(epoch);
  const db = new Database(f.options.databasePath);
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='state_observations'").get()).toBeUndefined();
  } finally { db.close(); }
});

test("SQLite append failure rejects the method and leaves no partial state observation", async () => {
  const f = await fixture();
  const db = new Database(f.options.databasePath);
  try {
    db.exec(`CREATE TRIGGER reject_state BEFORE INSERT ON events
      WHEN NEW.kind = 'state_epoch' BEGIN SELECT RAISE(ABORT, 'state append failure'); END;`);
    await expect(f.twin.computeStateEpoch(f.input)).rejects.toThrow("state append failure");
    expect(f.ledger.scan({ kind: "state_epoch", limit: 100 })).toEqual([]);
    expect(f.ledger.scan({ limit: 100 })).toEqual([]);
    db.exec("DROP TRIGGER reject_state");
    const epoch = await f.twin.computeStateEpoch(f.input);
    const events = f.ledger.scan({ kind: "state_epoch", limit: 100 });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual(epoch);
  } finally { db.close(); }
});

test("epochFor and revalidateMemory write no observations or memory changes", async () => {
  const f = await fixture();
  const epoch = await f.twin.computeStateEpoch(f.input);
  const remembered = memory(epoch);
  const before = structuredClone(remembered);
  const events = f.ledger.scan({ limit: 100 });
  await f.twin.epochFor(request(f.repo), epoch);
  expect(await f.twin.revalidateMemory(remembered, epoch)).toBe("active");
  expect(remembered).toEqual(before);
  expect(remembered.validity).toBe("quarantined");
  expect(remembered.utility_status).toBe("unmeasured");
  expect(f.ledger.scan({ limit: 100 })).toEqual(events);
});
