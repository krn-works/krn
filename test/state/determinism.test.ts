import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, test } from "vitest";
import { computeStateEpoch } from "../../src/state/index.js";
import { fixture, git, sha } from "./fixture.js";

test("State epoch determinism: later wall clock does not change epoch_id", async () => {
  const f = await fixture();
  const first = await computeStateEpoch(f.input);
  await setTimeout(10);
  const later = await computeStateEpoch(f.input);
  expect(later.created_at).not.toBe(first.created_at);
  expect(later.epoch_id).toBe(first.epoch_id);
  expect(later.manifest_hash).toBe(first.manifest_hash);
  expect(later.dirty_tree_hash).toBe(first.dirty_tree_hash);
  expect(later.state_revision_id).toBe(first.state_revision_id);
  expect(first.completeness).toBe("verified");
  expect(first.git_head).toBe(git(f.repo, "rev-parse", "HEAD"));
  expect(first.touched_file_hashes["state.txt"]).toBe(sha("version-one\n"));
});

test("manifest paths are framed and sorted by canonical UTF-8 bytes", async () => {
  const f = await fixture();
  const paths = ["z.txt", "tab\tname", "line\nname", "é.txt", "A.txt", "__proto__"];
  for (const path of paths) await writeFile(join(f.repo, path), path);
  const epoch = await computeStateEpoch(f.input);
  const keys = Object.keys(epoch.touched_file_hashes);
  expect(keys).toEqual([...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  for (const path of paths) expect(epoch.touched_file_hashes[path]).toBe(sha(path));
  expect((await computeStateEpoch(f.input)).epoch_id).toBe(epoch.epoch_id);
});

test("actual staged index representation is included without git status text", async () => {
  const f = await fixture();
  await writeFile(join(f.repo, "state.txt"), "changed\n");
  const worktree = await computeStateEpoch(f.input);
  git(f.repo, "add", "state.txt");
  const staged = await computeStateEpoch(f.input);
  expect(staged.touched_file_hashes).toEqual(worktree.touched_file_hashes);
  expect(staged.manifest_hash).toBe(worktree.manifest_hash);
  expect(staged.dirty_tree_hash).not.toBe(worktree.dirty_tree_hash);
  expect(staged.epoch_id).not.toBe(worktree.epoch_id);
});
