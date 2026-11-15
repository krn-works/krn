import { chmod, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { computeStateEpoch, revalidateMemory } from "../../src/state/index.js";
import { fixture, git, memory, sha } from "./fixture.js";

test("File mutation staleness: active in E1 becomes stale after dependent bytes change", async () => {
  const f = await fixture();
  const e1 = await computeStateEpoch(f.input);
  const remembered = memory(e1);
  expect(await revalidateMemory(remembered, e1)).toBe("active");
  await writeFile(join(f.repo, "state.txt"), "version-two\n");
  // Passing the old snapshot must not reuse its old file hash as fresh evidence.
  expect(await revalidateMemory(remembered, e1)).toBe("stale");
  const e2 = await computeStateEpoch(f.input);
  expect(e2.epoch_id).not.toBe(e1.epoch_id);
  expect(await revalidateMemory(remembered, e2)).toBe("stale");
});

test("deleted tracked file has an explicit MISSING measurement", async () => {
  const f = await fixture();
  const before = await computeStateEpoch(f.input);
  await unlink(join(f.repo, "state.txt"));
  const after = await computeStateEpoch(f.input);
  expect(after.completeness).toBe("verified");
  expect(after.touched_file_hashes["state.txt"]).toBe("MISSING");
  expect(after.epoch_id).not.toBe(before.epoch_id);
  expect(await revalidateMemory(memory(before), after)).toBe("stale");
  expect(await revalidateMemory(memory(after), after)).toBe("active");
});

test("rename records the removed tracked path and newly relevant untracked path", async () => {
  const f = await fixture();
  const before = await computeStateEpoch(f.input);
  await rename(join(f.repo, "state.txt"), join(f.repo, "renamed.txt"));
  const after = await computeStateEpoch(f.input);
  expect(after.touched_file_hashes["state.txt"]).toBe("MISSING");
  expect(after.touched_file_hashes["renamed.txt"]).toBe(before.touched_file_hashes["state.txt"]);
  expect(after.manifest_hash).not.toBe(before.manifest_hash);
  expect(await revalidateMemory(memory(before), after)).toBe("stale");
});

test("executable bit changes manifest and dirty hash without changing file bytes", async () => {
  const f = await fixture();
  await chmod(join(f.repo, "state.txt"), 0o644);
  const before = await computeStateEpoch(f.input);
  await chmod(join(f.repo, "state.txt"), 0o755);
  const after = await computeStateEpoch(f.input);
  expect(after.touched_file_hashes).toEqual(before.touched_file_hashes);
  expect(after.manifest_hash).not.toBe(before.manifest_hash);
  expect(after.dirty_tree_hash).not.toBe(before.dirty_tree_hash);
  expect(after.epoch_id).not.toBe(before.epoch_id);
});

test("uncommitted tracked changes and relevant untracked files are actual inputs", async () => {
  const f = await fixture();
  const before = await computeStateEpoch(f.input);
  await writeFile(join(f.repo, "new.txt"), "new dependency\n");
  const untracked = await computeStateEpoch(f.input);
  expect(untracked.touched_file_hashes["new.txt"]).toBe(sha("new dependency\n"));
  expect(untracked.epoch_id).not.toBe(before.epoch_id);
  expect(untracked.git_head).toBe(before.git_head);
  await writeFile(join(f.repo, "state.txt"), "uncommitted\n");
  const modified = await computeStateEpoch(f.input);
  expect(modified.epoch_id).not.toBe(untracked.epoch_id);
  expect(modified.git_head).toBe(before.git_head);
});

test("explicit environment and dependency installation fingerprint changes without Git changes", async () => {
  const f = await fixture();
  const before = await computeStateEpoch(f.input);
  const after = await computeStateEpoch({ ...f.input, environmentFingerprint: sha("different installed dependencies") });
  expect(after.git_head).toBe(before.git_head);
  expect(after.manifest_hash).toBe(before.manifest_hash);
  expect(after.dirty_tree_hash).toBe(before.dirty_tree_hash);
  expect(after.epoch_id).not.toBe(before.epoch_id);
  const remembered = memory(before);
  remembered.dependency_predicates = [{ kind: "environment_hash", key: "environment", expected: before.environment_fingerprint }];
  expect(await revalidateMemory(remembered, after)).toBe("stale");
});

test("same length and same mtime but different bytes cannot reuse a cached content hash", async () => {
  const f = await fixture();
  const path = join(f.repo, "state.txt");
  await writeFile(path, "AAAA");
  await utimes(path, 1700000000, 1700000000);
  const oldStat = await stat(path);
  const before = await computeStateEpoch(f.input);
  await writeFile(path, "BBBB");
  await utimes(path, 1700000000, 1700000000);
  const newStat = await stat(path);
  const after = await computeStateEpoch(f.input);
  expect(newStat.size).toBe(oldStat.size);
  expect(newStat.mtimeMs).toBe(oldStat.mtimeMs);
  expect(after.touched_file_hashes["state.txt"]).toBe(sha("BBBB"));
  expect(after.epoch_id).not.toBe(before.epoch_id);
  expect(await revalidateMemory(memory(before), after)).toBe("stale");
});

test("Git HEAD is measured even when an empty commit preserves all file bytes", async () => {
  const f = await fixture();
  const before = await computeStateEpoch(f.input);
  git(f.repo, "commit", "--allow-empty", "-qm", "new HEAD");
  const after = await computeStateEpoch(f.input);
  expect(after.manifest_hash).toBe(before.manifest_hash);
  expect(after.git_head).not.toBe(before.git_head);
  expect(after.epoch_id).not.toBe(before.epoch_id);
});
