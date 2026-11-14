import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  createLedgerMiddleware,
  type MemoryRecord
} from "../src/index.js";

await mkdir(join(process.cwd(), ".demo-dist", "src", "ledger"), { recursive: true });
await copyFile(
  join(process.cwd(), "src", "ledger", "schema.sql"),
  join(process.cwd(), ".demo-dist", "src", "ledger", "schema.sql")
);

const root = await mkdtemp(join(tmpdir(), "ledger-demo-"));
const repo = join(root, "repo");
execFileSync("mkdir", ["-p", repo]);
execFileSync("git", ["init", "-q", repo]);

await writeFile(join(repo, "state.txt"), "version-one\n");

const middleware = createLedgerMiddleware({
  repositoryRoot: repo,
  databasePath: join(root, "ledger.sqlite"),
  blobDirectory: join(root, "blobs"),
  digestByteLimit: 4096,
  maxRawBytesPerExecution: 64 * 1024 * 1024
});

const failing = {
  kind: "shell" as const,
  executable: process.execPath,
  argv: ["-e", "process.stderr.write('KNOWN_FAILURE\\n');process.exit(7)"],
  cwd: repo,
  dependencyPaths: ["state.txt"],
  timeoutMs: 5000
};

const first = await middleware.intercept({ ...failing, requestId: "loop-1" });
assert.equal(first.decision, "EXECUTED");

const second = await middleware.intercept({ ...failing, requestId: "loop-2" });
assert.equal(second.decision, "BLOCK");

const third = await middleware.intercept({ ...failing, requestId: "loop-3" });
assert.equal(third.decision, "BLOCK");
assert.ok(third.previousFailureId);
assert.equal(middleware.executionCountForEquivalentRequest(failing), 1);

const e1 = await middleware.computeStateEpoch();
const memory: MemoryRecord = middleware.fileMemoryFromEpoch("state.txt", e1);
assert.equal(await middleware.revalidateMemory(memory, e1), "active");

await writeFile(join(repo, "state.txt"), "version-two\n");
const e2 = await middleware.computeStateEpoch();
assert.notEqual(e1.epoch_id, e2.epoch_id);
assert.equal(await middleware.revalidateMemory(memory, e2), "stale");

const large = await middleware.intercept({
  requestId: "large-log-1",
  kind: "shell",
  executable: process.execPath,
  argv: ["-e", "process.stdout.write('x'.repeat(100 * 1024))"],
  cwd: repo,
  dependencyPaths: [],
  timeoutMs: 5000
});

assert.equal(large.decision, "EXECUTED");
if (large.decision !== "EXECUTED") throw new Error("Expected execution");
const raw = await middleware.readRawStdout(large.rawEventId);
assert.equal(raw.byteLength, 100 * 1024);
assert.equal(raw.toString("utf8"), "x".repeat(100 * 1024));
const contextFacing = JSON.stringify(large.digest);
assert.ok(Buffer.byteLength(contextFacing, "utf8") <= 4096);
assert.ok(!contextFacing.includes("x".repeat(100 * 1024)));

await middleware.close();
console.log("All three deterministic demo scenarios passed.");
