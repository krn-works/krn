import { symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { computeStateEpoch, revalidateMemory } from "../../src/state/index.js";
import { fixture, memory, request, sha } from "./fixture.js";

test("symlink outside scope hashes only the link and cannot establish verified preconditions", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "outside.txt"), "external-v1\n");
  await symlink("../outside.txt", join(f.repo, "outside-link"));
  const first = await computeStateEpoch(f.input);
  expect(first.touched_file_hashes["outside-link"]).toBe(sha("../outside.txt"));
  expect(first.completeness).toBe("unknown");
  await expect(f.twin.epochFor(request(f.repo, ["outside-link"]), first)).rejects.toThrow("unverified");
  expect(await revalidateMemory(memory(first, "outside-link"), first)).toBe("stale");
  await writeFile(join(f.root, "outside.txt"), "external-v2\n");
  expect((await computeStateEpoch(f.input)).manifest_hash).toBe(first.manifest_hash);
});

test("in-scope symlink target text is an input distinct from target file content", async () => {
  const f = await fixture();
  await writeFile(join(f.repo, "other.txt"), "version-one\n");
  await symlink("state.txt", join(f.repo, "link"));
  const first = await computeStateEpoch(f.input);
  expect(first.completeness).toBe("verified");
  expect(first.touched_file_hashes.link).toBe(sha("state.txt"));
  await unlink(join(f.repo, "link"));
  await symlink("other.txt", join(f.repo, "link"));
  const second = await computeStateEpoch(f.input);
  expect(second.touched_file_hashes.link).toBe(sha("other.txt"));
  expect(second.epoch_id).not.toBe(first.epoch_id);
  expect(await revalidateMemory(memory(first, "link"), second)).toBe("stale");
});

test("a symlink chain whose final target escapes scope is not verified", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "outside.txt"), "external\n");
  await symlink("../outside.txt", join(f.repo, "first-link"));
  await symlink("first-link", join(f.repo, "second-link"));
  const epoch = await computeStateEpoch(f.input);
  expect(epoch.completeness).toBe("unknown");
  expect(epoch.touched_file_hashes["second-link"]).toBe(sha("first-link"));
});
