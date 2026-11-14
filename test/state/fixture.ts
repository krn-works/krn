import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { openLedger, type EventLedger } from "../../src/ledger/index.js";
import { createStateTwin, type MemoryRecord, type StateEpoch, type StateInput } from "../../src/state/index.js";
import type { ExecutionRequest } from "../../src/adapters/types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
export function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "state-twin-test-"));
  const repo = join(root, "repo");
  const ledgers: EventLedger[] = [];
  cleanup.push(async () => {
    for (const ledger of ledgers) ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "State Twin fixture");
  git(repo, "config", "user.email", "state-fixture@example.invalid");
  await writeFile(join(repo, "state.txt"), "version-one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "fixture input");
  const options = {
    databasePath: join(root, "ledger.sqlite"), blobDirectory: join(root, "blobs"),
    projectId: "state-test", maxRawBytesPerExecution: 64 * 1024 * 1024,
  };
  const open = () => { const ledger = openLedger(options); ledgers.push(ledger); return ledger; };
  const ledger = open();
  const input: StateInput = {
    repositoryRoot: repo, environmentFingerprint: sha("explicit fixture environment"), testAttestations: {},
  };
  const twin = createStateTwin({ ledger, sessionId: "state-session", correlationId: "state-correlation" });
  return { root, repo, ledger, open, options, input, twin };
}
export function request(repo: string, dependencyPaths: readonly string[] = ["state.txt"]): ExecutionRequest {
  return {
    requestId: "state-request", sessionId: "state-session", goalId: "state-goal", kind: "shell",
    executable: process.execPath, argv: ["--version"], cwd: repo, environment: {}, dependencyPaths, timeoutMs: 5000,
  };
}
export function memory(epoch: StateEpoch, path = "state.txt"): MemoryRecord {
  const expected = epoch.touched_file_hashes[path];
  if (expected === undefined) throw new Error("fixture memory must name a measured file");
  return {
    id: "file-memory", kind: "fact", claim: { key: path, value: expected, wording: "Measured file dependency" },
    scope: { project_id: "state-test", worktree_id: null, paths: [path] },
    source_event_ids: ["fixture-source"], created_at: epoch.created_at, state_epoch: epoch.epoch_id,
    confidence: 1, validity: "quarantined", retrieval_keys: [], utility_score: null,
    dependency_predicates: [{ kind: "file_hash", key: path, expected }],
    supersedes: null, revalidated_at_epoch: null, utility_status: "unmeasured",
  };
}
