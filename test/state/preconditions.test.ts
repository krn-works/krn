import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { computeStateEpoch } from "../../src/state/index.js";
import { fixture, git, request, sha } from "./fixture.js";

test("unrelated file changes world epoch but not dependency-scoped experiment epoch", async () => {
  const f = await fixture();
  const before = await computeStateEpoch(f.input);
  const command = request(f.repo);
  const oldEpoch = await f.twin.epochFor(command, before);
  await writeFile(join(f.repo, "unrelated.txt"), "not an experiment dependency\n");
  const unrelated = await computeStateEpoch(f.input);
  expect(unrelated.epoch_id).not.toBe(before.epoch_id);
  expect(await f.twin.epochFor(command, unrelated)).toBe(oldEpoch);
  await writeFile(join(f.repo, "state.txt"), "relevant change\n");
  expect(await f.twin.epochFor(command, await computeStateEpoch(f.input))).not.toBe(oldEpoch);
});

test("epochFor hashes only HEAD, explicit environment and sorted measured dependency paths", async () => {
  const f = await fixture();
  await writeFile(join(f.repo, "another.txt"), "second\n");
  const world = await computeStateEpoch(f.input);
  const a = request(f.repo, ["state.txt", "another.txt"]);
  const b = { ...a, requestId: "different", argv: ["different argument"], dependencyPaths: ["another.txt", "./state.txt", "state.txt"] };
  const expected = sha(JSON.stringify([world.git_head, world.environment_fingerprint, [
    ["another.txt", world.touched_file_hashes["another.txt"]],
    ["state.txt", world.touched_file_hashes["state.txt"]],
  ]]));
  expect(await f.twin.epochFor(a, world)).toBe(expected);
  expect(await f.twin.epochFor(b, world)).toBe(expected);
  const changedKnowledge = { ...world, created_at: "2099-01-01T00:00:00.000Z", test_result_hashes: { run: sha("new") }, state_revision_id: sha("revision") };
  expect(await f.twin.epochFor(a, changedKnowledge)).toBe(expected);
});

test("Git HEAD and environment each change the experiment even for an empty dependency set", async () => {
  const f = await fixture();
  const command = request(f.repo, []);
  const before = await computeStateEpoch(f.input);
  const original = await f.twin.epochFor(command, before);
  const environment = await computeStateEpoch({ ...f.input, environmentFingerprint: sha("new environment") });
  expect(await f.twin.epochFor(command, environment)).not.toBe(original);
  git(f.repo, "commit", "--allow-empty", "-qm", "changed HEAD");
  expect(await f.twin.epochFor(command, await computeStateEpoch(f.input))).not.toBe(original);
});

test("MISSING is measured deletion; an unmeasured path is not invented as MISSING", async () => {
  const f = await fixture();
  const before = await computeStateEpoch(f.input);
  await unlink(join(f.repo, "state.txt"));
  const after = await computeStateEpoch(f.input);
  expect(await f.twin.epochFor(request(f.repo), after)).not.toBe(await f.twin.epochFor(request(f.repo), before));
  await expect(f.twin.epochFor(request(f.repo, ["never-measured"]), after)).rejects.toThrow("no measurement");
  await expect(f.twin.epochFor(request(f.repo, ["../outside"]), after)).rejects.toThrow("scope");
  await expect(f.twin.epochFor(request(f.repo), { ...after, completeness: "unknown" })).rejects.toThrow("unverified");
});
