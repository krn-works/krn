import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { computeStateEpoch, revalidateMemory } from "../../src/state/index.js";
import { fixture, git, memory, sha } from "./fixture.js";

test("every dependency predicate must match; absent measurements fail stale", async () => {
  const f = await fixture();
  const epoch = await computeStateEpoch({ ...f.input, testAttestations: { suite: sha("passed") } });
  const remembered = memory(epoch);
  remembered.dependency_predicates = [
    ...remembered.dependency_predicates,
    { kind: "environment_hash", key: "environment", expected: epoch.environment_fingerprint },
    { kind: "git_head", key: "HEAD", expected: epoch.git_head! },
    { kind: "test_fingerprint", key: "suite", expected: sha("passed") },
  ];
  expect(await revalidateMemory(remembered, epoch)).toBe("active");
  for (let index = 0; index < remembered.dependency_predicates.length; index += 1) {
    const changed = { ...remembered, dependency_predicates: remembered.dependency_predicates.map((predicate, position) =>
      position === index ? { ...predicate, expected: "mismatch" } : predicate) };
    expect(await revalidateMemory(changed, epoch)).toBe("stale");
  }
  for (const kind of ["file_hash", "test_fingerprint", "evidence_exists"] as const) {
    expect(await revalidateMemory({ ...remembered, dependency_predicates: [{ kind, key: "absent", expected: "true" }] }, epoch)).toBe("stale");
  }
});

test("new explicit test probes supersede historical attestations even through an old epoch handle", async () => {
  const f = await fixture();
  const old = await computeStateEpoch({ ...f.input, testAttestations: { suite: sha("passed") } });
  const remembered = memory(old);
  remembered.dependency_predicates = [{ kind: "test_fingerprint", key: "suite", expected: sha("passed") }];
  expect(await revalidateMemory(remembered, old)).toBe("active");
  const newer = await computeStateEpoch({ ...f.input, testAttestations: { suite: sha("failed") } });
  expect(newer.epoch_id).toBe(old.epoch_id);
  expect(await revalidateMemory(remembered, old)).toBe("stale");
  expect(await revalidateMemory(remembered, newer)).toBe("stale");
  expect(old.test_result_hashes.suite).toBe(sha("passed"));
});

test("new explicit environment probes are not replaced by an old epoch's fingerprint", async () => {
  const f = await fixture();
  const old = await computeStateEpoch(f.input);
  const remembered = memory(old);
  remembered.dependency_predicates = [{ kind: "environment_hash", key: "environment", expected: old.environment_fingerprint }];
  expect(await revalidateMemory(remembered, old)).toBe("active");
  await computeStateEpoch({ ...f.input, environmentFingerprint: sha("new installed environment") });
  expect(await revalidateMemory(remembered, old)).toBe("stale");
});

test("a test attestation is not transferred across changed inputs and Git HEAD is freshly read", async () => {
  const f = await fixture();
  const epoch = await computeStateEpoch({ ...f.input, testAttestations: { suite: sha("passed") } });
  const remembered = memory(epoch);
  remembered.dependency_predicates = [{ kind: "test_fingerprint", key: "suite", expected: sha("passed") }];
  await writeFile(join(f.repo, "state.txt"), "changed inputs\n");
  expect(await revalidateMemory(remembered, epoch)).toBe("stale");
  remembered.dependency_predicates = [{ kind: "git_head", key: "HEAD", expected: epoch.git_head! }];
  git(f.repo, "commit", "--allow-empty", "-qm", "new HEAD");
  expect(await revalidateMemory(remembered, epoch)).toBe("stale");
});

test("evidence_exists needs recoverable ledger evidence, not an invented source ID", async () => {
  const f = await fixture();
  const epoch = await f.twin.computeStateEpoch(f.input);
  const event = f.ledger.scan({ kind: "state_epoch", limit: 1 })[0]!;
  const remembered = memory(epoch);
  remembered.dependency_predicates = [{ kind: "evidence_exists", key: event.event_id, expected: "true" }];
  const before = f.ledger.scan({ limit: 100 });
  expect(await f.twin.revalidateMemory(remembered, epoch)).toBe("active");
  expect(await revalidateMemory(remembered, epoch)).toBe("stale");
  expect(f.ledger.scan({ limit: 100 })).toEqual(before);
  remembered.dependency_predicates = [{ kind: "evidence_exists", key: "invented", expected: "true" }];
  expect(await f.twin.revalidateMemory(remembered, epoch)).toBe("stale");
});

test("serialized snapshots alone are not fresh measurement capabilities", async () => {
  const f = await fixture();
  const epoch = await computeStateEpoch(f.input);
  const remembered = memory(epoch);
  expect(await revalidateMemory(remembered, structuredClone(epoch))).toBe("stale");
  expect(await revalidateMemory(remembered, { ...epoch, completeness: "unknown" })).toBe("stale");
});
