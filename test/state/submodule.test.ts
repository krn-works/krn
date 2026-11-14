import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { computeStateEpoch, revalidateMemory } from "../../src/state/index.js";
import { fixture, git, memory, request, sha } from "./fixture.js";

async function withSubmodule() {
  const f = await fixture();
  const source = join(f.root, "submodule-source");
  await mkdir(source);
  git(source, "init", "-q");
  git(source, "config", "user.name", "Submodule fixture");
  git(source, "config", "user.email", "submodule@example.invalid");
  await writeFile(join(source, "dependency.txt"), "submodule-v1\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "submodule input");
  git(f.repo, "-c", "protocol.file.allow=always", "submodule", "add", source, "dependency");
  git(f.repo, "commit", "-qam", "add submodule");
  return f;
}

test("submodule dirty bytes and nested per-file dependencies change measured state", async () => {
  const f = await withSubmodule();
  const before = await computeStateEpoch(f.input);
  const path = "dependency/dependency.txt";
  const command = request(f.repo, [path]);
  const original = await f.twin.epochFor(command, before);
  expect(before.completeness).toBe("verified");
  expect(before.touched_file_hashes[path]).toBe(sha("submodule-v1\n"));
  expect((await computeStateEpoch(f.input)).epoch_id).toBe(before.epoch_id);
  await writeFile(join(f.repo, path), "submodule-v2\n");
  const after = await computeStateEpoch(f.input);
  expect(after.completeness).toBe("verified");
  expect(after.git_head).toBe(before.git_head);
  expect(after.touched_file_hashes.dependency).not.toBe(before.touched_file_hashes.dependency);
  expect(after.touched_file_hashes[path]).toBe(sha("submodule-v2\n"));
  expect(after.epoch_id).not.toBe(before.epoch_id);
  expect(await f.twin.epochFor(command, after)).not.toBe(original);
  expect(await revalidateMemory(memory(before, path), after)).toBe("stale");
});

test("a submodule HEAD change is observed even with unchanged nested file bytes", async () => {
  const f = await withSubmodule();
  const before = await computeStateEpoch(f.input);
  const submodule = join(f.repo, "dependency");
  git(submodule, "-c", "user.name=Submodule fixture", "-c", "user.email=submodule@example.invalid", "commit", "--allow-empty", "-qm", "new nested HEAD");
  const after = await computeStateEpoch(f.input);
  expect(after.git_head).toBe(before.git_head);
  expect(after.touched_file_hashes["dependency/dependency.txt"]).toBe(before.touched_file_hashes["dependency/dependency.txt"]);
  expect(after.touched_file_hashes.dependency).not.toBe(before.touched_file_hashes.dependency);
  expect(after.epoch_id).not.toBe(before.epoch_id);
});

test("an uninitialized submodule is not silently attested from the gitlink alone", async () => {
  const f = await withSubmodule();
  git(f.repo, "submodule", "deinit", "-f", "--", "dependency");
  await expect(computeStateEpoch(f.input)).rejects.toThrow("uninitialized submodule");
});
