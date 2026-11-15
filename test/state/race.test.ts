import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { mkdir, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { computeStateEpoch, revalidateMemory } from "../../src/state/index.js";
import { fixture, memory, request } from "./fixture.js";

test("file changed during hashing is UNKNOWN, never a verified experiment", async () => {
  const f = await fixture();
  const path = join(f.repo, "a-racing.bin");
  await writeFile(path, Buffer.alloc(32 * 1024 * 1024, 65));
  const descriptor = openSync(path, "r+");
  const lease = join(f.repo, ".git", "state-twin.lease");
  let writes = 0;
  // Real writes on the actual filesystem, while the measurement holds its lease.
  // Chunked asynchronous hashing yields to this writer; no fs or clock mocks.
  const writer = setInterval(() => {
    if (existsSync(lease)) {
      writeSync(descriptor, Buffer.from([writes % 2 === 0 ? 66 : 65]), 0, 1, 0);
      writes += 1;
    }
  }, 1);
  let epoch;
  try { epoch = await computeStateEpoch(f.input); }
  finally { clearInterval(writer); closeSync(descriptor); }
  expect(writes).toBeGreaterThan(1);
  expect(epoch.completeness).toBe("unknown");
  await expect(f.twin.epochFor(request(f.repo, ["a-racing.bin"]), epoch)).rejects.toThrow("unverified");
  expect(await revalidateMemory(memory(epoch), epoch)).toBe("stale");
  expect(existsSync(lease)).toBe(false);
}, 15000);

test("an occupied worktree lease is not stolen and a released lease permits measurement", async () => {
  const f = await fixture();
  const lease = join(f.repo, ".git", "state-twin.lease");
  await mkdir(lease);
  try { await expect(computeStateEpoch(f.input)).rejects.toMatchObject({ code: "EEXIST" }); }
  finally { await rmdir(lease); }
  expect((await computeStateEpoch(f.input)).completeness).toBe("verified");
});
