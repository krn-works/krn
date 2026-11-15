import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAdapters, type ExecutionRequest } from "../../src/adapters/index.js";
import { canonical, createFailureGate } from "../../src/guards/index.js";
import { openLedger, type EventLedger } from "../../src/ledger/index.js";

async function expectGone(pid: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} is still alive`);
}

// SPEC R.0/R.1: exceeding the raw limit must terminate the running process,
// not merely truncate its archive after a different termination condition.
// This regression isolates that prerequisite to R.5 using the real modules.
// It is not an implementation of createLedgerMiddleware or the full S.3 suite.
it("R.0/R.1 raw overflow terminates a real child without waiting for its timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-raw-limit-"));
  let ledger: EventLedger | undefined;
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    const rawLimit = 4096;
    const storage = openLedger({
      databasePath: join(root, "ledger.sqlite"),
      blobDirectory: join(root, "blobs"),
      projectId: "raw-limit-regression",
      maxRawBytesPerExecution: rawLimit,
    });
    ledger = storage;
    const signingKey = randomBytes(32).toString("hex");
    const gate = createFailureGate({ ledger: storage, signingKey });
    const request: ExecutionRequest = {
      requestId: "raw-limit-request",
      sessionId: "raw-limit-session",
      goalId: "raw-limit-goal",
      kind: "shell",
      executable: process.execPath,
      argv: [
        "-e",
        "process.stdout.write(Buffer.alloc(8192, 120)); setInterval(() => {}, 1000);",
      ],
      cwd: repo,
      environment: {},
      dependencyPaths: [],
      timeoutMs: 2000,
    };
    storage.append({
      eventId: "raw-limit-proposal",
      sessionId: request.sessionId,
      correlationId: request.goalId,
      kind: "tool_proposal",
      sourceTimestamp: new Date().toISOString(),
      payload: { request: { ...request } },
      blobs: [],
    });
    const preflight = gate.preflight({
      request,
      preconditionEpoch: "raw-limit-isolated-regression",
    });
    expect(preflight.decision).toBe("ALLOW");
    if (preflight.decision !== "ALLOW") throw new Error("Expected first attempt to be allowed");

    let consumptions = 0;
    const decoratedLedger: EventLedger = { ...storage };
    const adapters = createAdapters({
      ledger: decoratedLedger,
      digestByteLimit: 4096,
      verifyAndConsumePermit(candidateRequest, candidatePermit) {
        expect(candidateRequest).toEqual(request);
        expect(candidatePermit).toEqual(preflight.permit);
        const { signature, ...unsigned } = candidatePermit;
        const expected = createHmac("sha256", signingKey)
          .update(canonical({ schema: "execution-permit/v1", ...unsigned }), "utf8")
          .digest();
        const actual = Buffer.from(signature, "hex");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          throw new Error("Invalid permit signature");
        }
        storage.transactionImmediate(db => {
          const changed = db.prepare(
            "UPDATE reservations SET status = 'started' WHERE id = ? AND request_hash = ? AND fencing_token = ? AND status = 'reserved'",
          ).run(candidatePermit.reservationId, candidatePermit.requestHash, candidatePermit.fencingToken);
          if (changed.changes !== 1) throw new Error("Permit is unrecognized or consumed");
          storage.append({
            eventId: "raw-limit-start-intent",
            sessionId: request.sessionId,
            correlationId: request.goalId,
            kind: "tool_started",
            sourceTimestamp: new Date().toISOString(),
            payload: { requestId: request.requestId, reservationId: candidatePermit.reservationId },
            blobs: [],
          });
        });
        consumptions += 1;
      },
    });

    const result = await adapters.execute(request, preflight.permit);
    storage.transactionImmediate(db => {
      const changed = db.prepare(
        "UPDATE reservations SET status = 'completed' WHERE id = ? AND status = 'started'",
      ).run(preflight.permit.reservationId);
      expect(changed.changes).toBe(1);
    });
    if (result.digest.kind !== "shell") throw new Error("Expected shell digest");
    const event = storage.getEvent(result.rawEventId);
    const stdout = result.rawBlobs[0];
    if (stdout === undefined) throw new Error("Missing stdout capture");
    expect(consumptions).toBe(1);
    // ShellDigest reports archived bytes; incomplete capture establishes overflow.
    expect(result.digest.stdout_bytes).toBe(stdout.bytes);
    expect(result.digest.capture_complete).toBe(false);
    expect(event?.capture_status).toBe("partial");
    expect(stdout.complete).toBe(false);
    expect(stdout.bytes).toBe(rawLimit);
    expect(Buffer.from(await storage.readBlob(stdout.hash))).toEqual(Buffer.alloc(rawLimit, 120));
    console.info("raw-limit reproduction:", JSON.stringify({
      configured_limit: rawLimit,
      fixture_stdout_bytes: 8192,
      digest_stdout_bytes: result.digest.stdout_bytes,
      archived_stdout_bytes: stdout.bytes,
      capture_complete: result.digest.capture_complete,
      termination_signal: result.digest.termination_signal,
    }));
    expect(result.digest.termination_signal).toBe("RAW_LIMIT_EXCEEDED");
    expect(result.digest.duration_ms).toBeLessThan(request.timeoutMs / 2);
  } finally {
    try { ledger?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 15000);

it("R.0/R.1 raw limit is shared by stdout and stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-raw-limit-both-"));
  let ledger: EventLedger | undefined;
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    const rawLimit = 4096;
    const storage = openLedger({
      databasePath: join(root, "ledger.sqlite"),
      blobDirectory: join(root, "blobs"),
      projectId: "raw-limit-both-regression",
      maxRawBytesPerExecution: rawLimit,
    });
    ledger = storage;
    const signingKey = randomBytes(32).toString("hex");
    const gate = createFailureGate({ ledger: storage, signingKey });
    if (process.platform === "win32") throw new Error("BLOCKED: process-group reap falsifier requires POSIX");
    const descendantPidFile = join(root, "descendant.pid");
    const lateFile = join(root, "late-descendant.txt");
    const stderrPayload = `ERROR shared raw limit\n${"y".repeat(3072 - Buffer.byteLength("ERROR shared raw limit\n"))}`;
    const request: ExecutionRequest = {
      requestId: "raw-limit-both-request",
      sessionId: "raw-limit-both-session",
      goalId: "raw-limit-both-goal",
      kind: "shell",
      executable: process.execPath,
      argv: [
        "-e",
        `const fs=require('fs');const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(lateFile)},'orphan'),800);setInterval(()=>{},1000);`)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(descendantPidFile)},String(c.pid));process.stderr.write(Buffer.from(${JSON.stringify(stderrPayload)}));process.stdout.write(Buffer.alloc(3072,120));setInterval(()=>{},1000);`,
      ],
      cwd: repo,
      environment: {},
      dependencyPaths: [],
      timeoutMs: 2000,
    };
    storage.append({
      eventId: "raw-limit-both-proposal",
      sessionId: request.sessionId,
      correlationId: request.goalId,
      kind: "tool_proposal",
      sourceTimestamp: new Date().toISOString(),
      payload: { request: { ...request } },
      blobs: [],
    });
    const preflight = gate.preflight({ request, preconditionEpoch: "raw-limit-both-isolated-regression" });
    expect(preflight.decision).toBe("ALLOW");
    if (preflight.decision !== "ALLOW") throw new Error("Expected first attempt to be allowed");

    const decoratedLedger: EventLedger = { ...storage };
    const adapters = createAdapters({
      ledger: decoratedLedger,
      digestByteLimit: 4096,
      verifyAndConsumePermit(candidateRequest, candidatePermit) {
        expect(candidateRequest).toEqual(request);
        expect(candidatePermit).toEqual(preflight.permit);
        const { signature, ...unsigned } = candidatePermit;
        const expected = createHmac("sha256", signingKey)
          .update(canonical({ schema: "execution-permit/v1", ...unsigned }), "utf8")
          .digest();
        const actual = Buffer.from(signature, "hex");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid permit signature");
        storage.transactionImmediate(db => {
          const changed = db.prepare(
            "UPDATE reservations SET status = 'started' WHERE id = ? AND request_hash = ? AND fencing_token = ? AND status = 'reserved'",
          ).run(candidatePermit.reservationId, candidatePermit.requestHash, candidatePermit.fencingToken);
          if (changed.changes !== 1) throw new Error("Permit is unrecognized or consumed");
          storage.append({
            eventId: "raw-limit-both-start-intent",
            sessionId: request.sessionId,
            correlationId: request.goalId,
            kind: "tool_started",
            sourceTimestamp: new Date().toISOString(),
            payload: { requestId: request.requestId, reservationId: candidatePermit.reservationId },
            blobs: [],
          });
        });
      },
    });

    const result = await adapters.execute(request, preflight.permit);
    if (result.digest.kind !== "shell") throw new Error("Expected shell digest");
    const event = storage.getEvent(result.rawEventId);
    const stdout = result.rawBlobs[0];
    const stderr = result.rawBlobs[1];
    if (stdout === undefined || stderr === undefined) throw new Error("Missing capture receipt");
    expect(stdout.bytes + stderr.bytes).toBe(rawLimit);
    expect(result.digest.stdout_bytes + result.digest.stderr_bytes).toBe(rawLimit);
    expect(result.digest.capture_complete).toBe(false);
    expect(event?.capture_status).toBe("partial");
    expect(stdout.complete && stderr.complete).toBe(false);
    expect(result.digest.termination_signal).toBe("RAW_LIMIT_EXCEEDED");
    expect(result.digest.duration_ms).toBeLessThan(request.timeoutMs / 2);
    const descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
    await expectGone(descendantPid);
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(existsSync(lateFile)).toBe(false);
    const error = result.digest.salient_errors[0];
    if (error === undefined) throw new Error("Expected a bounded error source");
    expect(Buffer.from(await storage.readFragment(error.source)).toString("utf8")).toContain("ERROR shared raw limit");
  } finally {
    try { ledger?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 15000);
