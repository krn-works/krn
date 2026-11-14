import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExecutionRequest } from "../adapters/types.js";
import type { EventLedger, Id, Json } from "../ledger/types.js";
import type { Hash, MemoryRecord, StateEpoch, StateInput, StateTwin } from "./types.js";

export type * from "./types.js";

type Entry = { path: string; type: string; mode: number; hash: string };
type IndexEntry = { path: string; mode: string; object: string; stage: string };
type Snapshot = {
  head: string | null;
  entries: Entry[];
  index: IndexEntry[];
  stamps: string[];
  verified: boolean;
};

// These are measurement capabilities, not cached facts. A deserialized epoch
// has no filesystem capability and cannot by itself prove freshness.
type MeasurementContext = { input: StateInput };
const measurementInputs = new WeakMap<StateEpoch, MeasurementContext>();
// Keep the latest explicitly supplied environment/attestation probes, not file
// facts. Revalidation always rereads the filesystem and must not resurrect
// historical attestations just because an older epoch object was passed in.
const inputContexts = new Map<string, WeakRef<MeasurementContext>>();
const contextCleanup = new FinalizationRegistry<string>((root) => {
  if (inputContexts.get(root)?.deref() === undefined) inputContexts.delete(root);
});

function hash(value: string | Uint8Array): Hash {
  return createHash("sha256").update(value).digest("hex");
}
function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function hashJson(value: unknown): Hash { return hash(JSON.stringify(value)); }
function pairs(values: Readonly<Record<string, string>>): [string, string][] {
  return Object.keys(values).sort(comparePaths).map((key) => [key, values[key]!]);
}
function git(root: string, args: string[]): Buffer {
  return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
}
function line(bytes: Buffer): string { return bytes.toString("utf8").replace(/\n$/, ""); }
function head(root: string): string | null {
  try { return line(git(root, ["rev-parse", "--verify", "HEAD"])); }
  catch (error) {
    // An unborn branch is not the same as a broken repository or an unreadable ref.
    const symbolic = line(git(root, ["symbolic-ref", "-q", "HEAD"]));
    try { git(root, ["show-ref", "--verify", "--quiet", symbolic]); }
    catch (missing) {
      if ((missing as { status?: number }).status === 1) return null;
      throw missing;
    }
    throw error;
  }
}
function nulRecords(bytes: Buffer): string[] {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("non-UTF-8 Git path cannot be represented losslessly");
  if (text === "") return [];
  if (!text.endsWith("\0")) throw new Error("incomplete NUL-delimited Git output");
  return text.slice(0, -1).split("\0");
}
function inScope(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function canonicalPath(path: string): string {
  if (path === "" || path.includes("\0") || isAbsolute(path)) throw new Error("invalid repository-relative path");
  const canonical = path.split("/").filter((part) => part !== "" && part !== ".");
  if (canonical.length === 0 || canonical.includes("..") || canonical.includes(".git")) {
    throw new Error("path is outside measurement scope");
  }
  return canonical.join("/");
}
function stamp(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function measureEntry(root: string, path: string, submodule: boolean): Promise<{
  entry: Entry; stamp: string; verified: boolean;
  children?: { entry: Entry; stamp: string }[];
}> {
  const absolute = join(root, canonicalPath(path));
  const absent = { entry: { path, type: "missing", mode: 0, hash: "MISSING" }, stamp: "MISSING", verified: true };
  let before: BigIntStats;
  try {
    // Never follow a replaced parent directory out of the repository.
    if (!inScope(root, await realpath(dirname(absolute)))) throw new Error("parent path escapes repository scope");
    before = await lstat(absolute, { bigint: true });
  } catch (error) {
    if (missing(error)) return absent;
    throw error;
  }
  const mode = Number(before.mode & 0o7777n);
  let content: string;
  let type: string;
  let verified = true;
  if (before.isSymbolicLink()) {
    type = "symlink";
    const target = await readlink(absolute, { encoding: "buffer" });
    content = hash(target);
    // Hash the link itself, never the bytes of an out-of-scope target.
    const targetText = target.toString("utf8");
    verified = Buffer.from(targetText).equals(target) && inScope(root, resolve(dirname(absolute), targetText));
    if (verified) {
      try { verified = inScope(root, await realpath(absolute)); }
      catch (error) { if (!missing(error)) verified = false; }
    }
  } else if (before.isFile()) {
    type = "file";
    const descriptor = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const initial = await descriptor.stat({ bigint: true });
      const digest = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        digest.update(buffer.subarray(0, bytesRead));
      }
      content = digest.digest("hex");
      const final = await descriptor.stat({ bigint: true });
      verified = stamp(before) === stamp(initial) && stamp(initial) === stamp(final);
    } finally { await descriptor.close(); }
  } else if (before.isDirectory() && submodule) {
    type = "submodule";
    // A gitlink alone cannot attest a dirty or uninitialized submodule worktree.
    const top = await realpath(line(git(absolute, ["rev-parse", "--show-toplevel"])));
    if (top !== absolute) throw new Error("uninitialized submodule cannot be measured");
    const nested = await snapshot(absolute);
    content = hashJson([nested.head, nested.index, nested.entries]);
    verified = nested.verified;
    const after = await lstat(absolute, { bigint: true });
    return {
      entry: { path, type, mode, hash: content },
      stamp: hashJson([stamp(before), nested.stamps, stamp(after)]),
      verified: verified && stamp(before) === stamp(after),
      children: nested.entries.map((entry, index) => ({
        entry: { ...entry, path: `${path}/${entry.path}` }, stamp: nested.stamps[index]!,
      })),
    };
  } else {
    throw new Error(`unsupported filesystem type: ${path}`);
  }
  let after: BigIntStats;
  try { after = await lstat(absolute, { bigint: true }); }
  catch (error) {
    if (missing(error)) return { entry: { path, type, mode, hash: content }, stamp: stamp(before), verified: false };
    throw error;
  }
  return { entry: { path, type, mode, hash: content }, stamp: stamp(before), verified: verified && stamp(before) === stamp(after) };
}

async function snapshot(root: string): Promise<Snapshot> {
  const startHead = head(root);
  const index = nulRecords(git(root, ["ls-files", "--stage", "-z"])).map((record): IndexEntry => {
    const tab = record.indexOf("\t");
    const fields = record.slice(0, tab).split(" ");
    if (tab < 0 || fields.length !== 3) throw new Error("malformed Git index record");
    return { path: canonicalPath(record.slice(tab + 1)), mode: fields[0]!, object: fields[1]!, stage: fields[2]! };
  }).sort((a, b) => comparePaths(a.path, b.path) || comparePaths(a.stage, b.stage));
  const untracked = nulRecords(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const paths = [...new Set([...index.map((entry) => entry.path), ...untracked.map(canonicalPath)])].sort(comparePaths);
  const submodules = new Set(index.filter((entry) => entry.mode === "160000").map((entry) => entry.path));
  const entries: Entry[] = [];
  const stamps: string[] = [];
  let verified = index.every((entry) => entry.stage === "0");
  for (const path of paths) {
    const measured = await measureEntry(root, path, submodules.has(path));
    entries.push(measured.entry);
    stamps.push(measured.stamp);
    for (const child of measured.children ?? []) {
      entries.push(child.entry);
      stamps.push(child.stamp);
    }
    verified &&= measured.verified;
  }
  const ordered = entries.map((entry, position) => ({ entry, stamp: stamps[position]! }))
    .sort((a, b) => comparePaths(a.entry.path, b.entry.path));
  return {
    head: startHead, index, entries: ordered.map((item) => item.entry),
    stamps: ordered.map((item) => item.stamp), verified,
  };
}

/** Steps 1–11 of R.3. No database is opened and no ledger event is written. */
export async function computeStateEpoch(input: StateInput): Promise<StateEpoch> {
  const root = await realpath(input.repositoryRoot);
  if (await realpath(line(git(root, ["rev-parse", "--show-toplevel"]))) !== root) {
    throw new Error("repositoryRoot must be the worktree root");
  }
  const environment = input.environmentFingerprint;
  const attestations = Object.freeze(Object.fromEntries(pairs(input.testAttestations)));
  const gitDirectory = line(git(root, ["rev-parse", "--absolute-git-dir"]));
  const lease = join(gitDirectory, "state-twin.lease");
  // Atomic across processes; an existing lease is never silently stolen.
  await mkdir(lease);
  try {
    const first = await snapshot(root);
    const second = await snapshot(root);
    // Metadata detects in-flight replacement; only stable inputs enter hashes.
    const verified = first.verified && second.verified && hashJson(first) === hashJson(second);
    const manifestHash = hashJson(first.entries);
    const dirtyTreeHash = hashJson([first.index, first.entries]);
    const epochId = hashJson([manifestHash, first.head, dirtyTreeHash, environment]);
    const epoch: StateEpoch = Object.freeze({
      epoch_id: epochId,
      git_head: first.head,
      dirty_tree_hash: dirtyTreeHash,
      touched_file_hashes: Object.freeze(Object.fromEntries(first.entries.map((entry) => [entry.path, entry.hash]))),
      test_result_hashes: attestations,
      environment_fingerprint: environment,
      created_at: new Date().toISOString(),
      manifest_hash: manifestHash,
      state_revision_id: hashJson([epochId, pairs(attestations)]),
      completeness: verified ? "verified" : "unknown",
    });
    const measuredInput = Object.freeze({
      repositoryRoot: root, environmentFingerprint: environment, testAttestations: attestations,
    });
    let context = inputContexts.get(root)?.deref();
    if (context === undefined) {
      context = { input: measuredInput };
      inputContexts.set(root, new WeakRef(context));
      contextCleanup.register(context, root);
    } else { context.input = measuredInput; }
    measurementInputs.set(epoch, context);
    return epoch;
  } finally { await rmdir(lease); }
}

async function epochFor(request: ExecutionRequest, world: StateEpoch): Promise<Hash> {
  if (world.completeness !== "verified") throw new Error("unverified world cannot establish preconditions");
  const dependencies = [...new Set(request.dependencyPaths.map(canonicalPath))].sort(comparePaths);
  const measurements = dependencies.map((path) => {
    if (!Object.hasOwn(world.touched_file_hashes, path)) throw new Error(`dependency has no measurement: ${path}`);
    return [path, world.touched_file_hashes[path]!];
  });
  return hashJson([world.git_head, world.environment_fingerprint, measurements]);
}

async function revalidate(
  memory: MemoryRecord, epoch: StateEpoch, ledger?: EventLedger,
): Promise<"active" | "stale"> {
  if (epoch.completeness !== "verified") return "stale";
  const input = measurementInputs.get(epoch)?.input;
  if (input === undefined) return "stale";
  let fresh: StateEpoch;
  try { fresh = await computeStateEpoch(input); }
  catch { return "stale"; }
  if (fresh.completeness !== "verified") return "stale";
  for (const predicate of memory.dependency_predicates) {
    let observed: string | undefined;
    switch (predicate.kind) {
      case "file_hash": {
        let path: string;
        try { path = canonicalPath(predicate.key); }
        catch { return "stale"; }
        if (Object.hasOwn(fresh.touched_file_hashes, path)) observed = fresh.touched_file_hashes[path];
        break;
      }
      case "environment_hash": observed = fresh.environment_fingerprint; break;
      case "git_head": observed = fresh.git_head ?? undefined; break;
      case "test_fingerprint":
        // An old attestation cannot be transferred to newly changed inputs.
        if (fresh.epoch_id === epoch.epoch_id && Object.hasOwn(fresh.test_result_hashes, predicate.key)) {
          observed = fresh.test_result_hashes[predicate.key];
        }
        break;
      case "evidence_exists":
        if (ledger !== undefined) {
          try {
            const event = ledger.getEvent(predicate.key);
            if (event !== undefined) {
              for (const blob of event.raw_blob_hashes) await ledger.readBlob(blob);
              observed = "true";
            }
          } catch { return "stale"; }
        }
        break;
      default: return "stale";
    }
    if (observed === undefined || observed !== predicate.expected) return "stale";
  }
  // This result says nothing about quarantine, claim truth or utility promotion.
  return "active";
}

export function revalidateMemory(memory: MemoryRecord, epoch: StateEpoch): Promise<"active" | "stale"> {
  return revalidate(memory, epoch);
}

export function createStateTwin(options: {
  ledger: EventLedger; sessionId: Id; correlationId: Id;
}): StateTwin {
  const { ledger, sessionId, correlationId } = options;
  return {
    async computeStateEpoch(input) {
      const epoch = await computeStateEpoch(input);
      ledger.append({
        eventId: randomUUID(), sessionId, correlationId, kind: "state_epoch",
        sourceTimestamp: epoch.created_at, payload: JSON.parse(JSON.stringify(epoch)) as Json, blobs: [],
      });
      return epoch;
    },
    epochFor,
    revalidateMemory: (memory, epoch) => revalidate(memory, epoch, ledger),
  };
}
