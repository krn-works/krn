import { expect, test } from "vitest";
import { computeStateEpoch } from "../../src/state/index.js";
import { fixture, request, sha } from "./fixture.js";

test("Test-result self-invalidation: test results, timing, failure and new event IDs keep the experiment epoch", async () => {
  const f = await fixture();
  const first = await f.twin.computeStateEpoch(f.input);
  const command = request(f.repo);
  const preconditions = await f.twin.epochFor(command, first);
  for (let index = 1; index <= 3; index += 1) {
    f.ledger.append({
      eventId: `test-result-${index}`, sessionId: "test-run", correlationId: "test-run",
      kind: "test_outcome", sourceTimestamp: new Date().toISOString(),
      payload: { tested_epoch: preconditions, outcome: "fail", duration_ms: index * 137 }, blobs: [],
    });
    f.ledger.append({
      eventId: `failure-${index}`, sessionId: "test-run", correlationId: "test-run",
      kind: "memory_write", sourceTimestamp: new Date().toISOString(),
      payload: { kind: "failure", state_epoch: preconditions, recurrence_count: index }, blobs: [],
    });
    const observed = await f.twin.computeStateEpoch({
      ...f.input, testAttestations: { [preconditions]: sha(`attestation-${index}`) },
    });
    expect(observed.epoch_id).toBe(first.epoch_id);
    expect(observed.manifest_hash).toBe(first.manifest_hash);
    expect(observed.dirty_tree_hash).toBe(first.dirty_tree_hash);
    expect(await f.twin.epochFor(command, observed)).toBe(preconditions);
    expect(observed.state_revision_id).not.toBe(first.state_revision_id);
    expect(observed.test_result_hashes[preconditions]).toBe(sha(`attestation-${index}`));
  }
  const events = f.ledger.scan({ kind: "state_epoch", limit: 100 });
  expect(events).toHaveLength(4);
  expect(new Set(events.map((event) => event.event_id)).size).toBe(4);
});

test("attestation normalization preserves revision under different object insertion orders", async () => {
  const f = await fixture();
  const first = await computeStateEpoch({ ...f.input, testAttestations: { z: sha("z"), a: sha("a") } });
  const reordered = await computeStateEpoch({ ...f.input, testAttestations: { a: sha("a"), z: sha("z") } });
  expect(reordered.epoch_id).toBe(first.epoch_id);
  expect(reordered.state_revision_id).toBe(first.state_revision_id);
  expect(reordered.test_result_hashes).toEqual(first.test_result_hashes);
});
