import { createHash } from "node:crypto";
import { accessSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createAdapters, type ExecutionPermit, type ExecutionRequest } from "../../src/adapters/index.js";
import { openLedger, type EventLedger } from "../../src/ledger/index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = mkdtempSync(join(tmpdir(), "adapters-test-")); roots.push(value); return value; }
function ledgerAt(base: string): EventLedger { return openLedger({ databasePath: join(base, "ledger.sqlite"), blobDirectory: join(base, "blobs"), projectId: "project", maxRawBytesPerExecution: 64 * 1024 * 1024 }); }
function permit(id: string): ExecutionPermit { return { reservationId: `reservation-${id}`, requestHash: `hash-${id}`, preconditionEpoch: "epoch", fencingToken: 1, signature: "sig" }; }
function req(base: string, kind: ExecutionRequest["kind"], executable: string, argv: string[], id: string, dependencyPaths: string[] = []): ExecutionRequest {
  return { requestId: id, sessionId: "session", goalId: "goal", kind, executable, argv, cwd: base, environment: {}, dependencyPaths, timeoutMs: 5000 };
}
function adapters(ledger: EventLedger) {
  const used = new Set<string>();
  return createAdapters({ ledger, digestByteLimit: 4096, verifyAndConsumePermit(request, p) { if (p.requestHash !== `hash-${request.requestId}` || used.has(p.reservationId)) throw new Error("invalid or consumed permit"); used.add(p.reservationId); } });
}
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function expectGone(pid: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} is still alive`);
}

describe("Acquisition adapters", () => {
  it("rejects an invalid digest limit at construction", () => {
    const base = root(); const ledger = ledgerAt(base);
    for (const digestByteLimit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => createAdapters({ ledger, digestByteLimit, verifyAndConsumePermit() {} })).toThrow(/digestByteLimit/);
    }
    ledger.close();
  });

  it("returns a spawn error for a missing executable without crashing the host", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    await expect(api.execute(req(base, "shell", join(base, "missing-executable"), [], "spawn-error"), permit("spawn-error"))).rejects.toThrow(/ENOENT|spawn/i);
    ledger.close();
  });

  it("snapshots mutable request fields before asynchronous capture", async () => {
    const base = root(); const ledger = ledgerAt(base);
    const original = req(base, "shell", process.execPath, ["-e", "process.stdout.write('stable')"], "snapshot");
    const originalArgv = original.argv as string[];
    const api = createAdapters({ ledger, digestByteLimit: 4096, verifyAndConsumePermit() { originalArgv[1] = "process.stdout.write('tampered')"; } });
    const result = await api.execute(original, permit("snapshot"));
    if (result.digest.kind !== "shell") throw new Error("wrong digest");
    expect(result.digest.stdout_bytes).toBe(Buffer.byteLength("stable"));
    ledger.close();
  });

  it("shell archives raw, records receipt payload, and measures changed_artifacts from filesystem", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const request = req(base, "shell", process.execPath, ["-e", "require('fs').writeFileSync('made.txt','hello');process.stderr.write('ERROR boom\\n')"], "shell-1", ["made.txt"]);
    const result = await api.execute(request, permit("shell-1"));
    expect(result.digest.kind).toBe("shell");
    if (result.digest.kind !== "shell") throw new Error("wrong digest");
    expect(result.digest.changed_artifacts).toEqual([{ path: "made.txt", before: "MISSING", after: sha("hello") }]);
    expect(result.digest.receipt_id).toBe(result.rawEventId);
    const event = ledger.getEvent(result.digest.receipt_id); expect(event?.kind).toBe("tool_output");
    expect(event?.payload).toMatchObject({ requestId: "shell-1", reservationId: "reservation-shell-1", adapterKind: "shell" });
    expect(result.digest.salient_errors.length).toBeGreaterThan(0);
    const handle = result.digest.salient_errors[0]!.source;
    expect(Buffer.from(await ledger.readFragment(handle)).toString("utf8")).toContain("ERROR boom");
    expect(Buffer.byteLength(JSON.stringify(result.digest), "utf8")).toBeLessThanOrEqual(4096);
    ledger.close();
  });

  it("ADR-008 ignores process text that merely says wrote file", async () => {
    const base = root(); writeFileSync(join(base, "stable.txt"), "same"); const ledger = ledgerAt(base); const api = adapters(ledger);
    const result = await api.execute(req(base, "shell", process.execPath, ["-e", "console.log('wrote file')"], "shell-2", ["stable.txt"]), permit("shell-2"));
    if (result.digest.kind !== "shell") throw new Error("wrong digest");
    expect(result.digest.changed_artifacts).toEqual([]); ledger.close();
  });

  it("ADR-008 reports modified files with real before/after hashes", async () => {
    const base = root(); writeFileSync(join(base, "state.txt"), "before"); const ledger = ledgerAt(base); const api = adapters(ledger);
    const result = await api.execute(req(base, "shell", process.execPath, ["-e", "require('fs').writeFileSync('state.txt','after')"], "shell-3", ["state.txt"]), permit("shell-3"));
    if (result.digest.kind !== "shell") throw new Error("wrong digest");
    expect(result.digest.changed_artifacts).toEqual([{ path: "state.txt", before: sha("before"), after: sha("after") }]); ledger.close();
  });

  it("bounds salient errors and keeps raw source spans with ANSI and UTF-8 text", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const output = "prefix żółć \u001b[31mERROR first\u001b[0m  \n" + Array.from({ length: 7 }, (_, i) => `ERROR ${i + 1}\n`).join("") + Array.from({ length: 8 }, (_, i) => `WARNING ${i}\n`).join("") + "ERROR warning overlap\n";
    const result = await api.execute(req(base, "shell", process.execPath, ["-e", `process.stderr.write(${JSON.stringify(output)})`], "errors"), permit("errors"));
    if (result.digest.kind !== "shell") throw new Error("wrong digest");
    expect(result.digest.salient_errors).toHaveLength(8);
    expect(result.digest.warning_signatures).toHaveLength(8);
    expect(result.digest.truncated).toBe(true);
    expect(result.digest.omitted_count).toBe(1);
    const first = result.digest.salient_errors[0]!;
    expect(Buffer.from(await ledger.readFragment(first.source)).toString("utf8")).toContain("ERROR first");
    ledger.close();
  });

  it("keeps shell source offsets byte-accurate after invalid UTF-8", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const result = await api.execute(req(base, "shell", process.execPath, ["-e", "process.stderr.write(Buffer.from([255]));process.stderr.write('\\nERROR after-invalid\\n')"], "invalid-shell"), permit("invalid-shell"));
    if (result.digest.kind !== "shell") throw new Error("wrong digest");
    const raw = await ledger.readFragment(result.digest.salient_errors[0]!.source);
    expect(result.digest.salient_errors[0]!.source.byte_start).toBe(2);
    expect(Buffer.from(raw).toString("utf8")).toBe("ERROR after-invalid\n"); ledger.close();
  });

  it("rejects a consumed permit before second spawn", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger); const p = permit("permit");
    const request = req(base, "shell", process.execPath, ["-e", "require('fs').appendFileSync('spawn-count','x')"], "permit");
    await api.execute(request, p); await expect(api.execute(request, p)).rejects.toThrow(/consumed/);
    expect(readFileSync(join(base, "spawn-count"), "utf8")).toBe("x"); ledger.close();
  });

  it("test-runner parses a real failing Vitest JSON report and resolves failed test source", async () => {
    const base = root(); mkdirSync(join(base, "fixture"));
    writeFileSync(join(base, "fixture", "fail.test.js"), "import { describe, test, expect } from 'vitest'; describe('first suite',()=>{ test('fixture failure',()=>expect(1).toBe(1)); test('fixture failure',()=>expect(1).toBe(2)); }); describe('second suite',()=>test('fixture failure',()=>expect(2).toBe(3)));\n");
    const ledger = ledgerAt(base); const api = adapters(ledger);
    const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
    const result = await api.execute(req(base, "test-runner", process.execPath, [vitest, "run", "fixture/fail.test.js", "--reporter=json"], "vitest"), permit("vitest"));
    expect(result.digest.kind).toBe("test-runner"); if (result.digest.kind !== "test-runner") throw new Error("wrong digest");
    expect(result.digest.failed).toBeGreaterThanOrEqual(2); expect(result.digest.failed_tests).toHaveLength(2);
    expect(ledger.getEvent(result.digest.receipt_id)).toBeDefined();
    const firstRaw = Buffer.from(await ledger.readFragment(result.digest.failed_tests[0]!.source)).toString("utf8");
    const secondRaw = Buffer.from(await ledger.readFragment(result.digest.failed_tests[1]!.source)).toString("utf8");
    expect(firstRaw).toContain("fixture failure"); expect(secondRaw).toContain("fixture failure");
    expect(result.digest.failed_tests[0]!.source.byte_start).not.toBe(result.digest.failed_tests[1]!.source.byte_start); ledger.close();
  });

  it("keeps test-runner source resolvable when JSON contains invalid UTF-8", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const prefix = Buffer.from('{"numTotalTests":1,"numPassedTests":0,"numFailedTests":1,"numPendingTests":0,"testResults":[{"name":"fixture","assertionResults":[{"title":"invalid output","status":"failed","failureMessages":["');
    const suffix = Buffer.from('"]}]}]}');
    const result = await api.execute(req(base, "test-runner", process.execPath, ["-e", `process.stdout.write(Buffer.concat([Buffer.from(${JSON.stringify(prefix.toString())}),Buffer.from([255]),Buffer.from(${JSON.stringify(suffix.toString())})]))`], "invalid-runner"), permit("invalid-runner"));
    if (result.digest.kind !== "test-runner") throw new Error("wrong digest");
    expect(result.digest.parser_status).toBe("partial"); expect(result.digest.failed_tests).toHaveLength(1);
    const raw = await ledger.readFragment(result.digest.failed_tests[0]!.source);
    expect(raw[0]).toBe(123); expect(raw).toContain(255); ledger.close();
  });

  it("malformed test JSON is unknown with bounded raw handle and exit 0 is not promoted to pass", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const result = await api.execute(req(base, "test-runner", process.execPath, ["-e", "process.stdout.write('{broken')"], "malformed"), permit("malformed"));
    if (result.digest.kind !== "test-runner") throw new Error("wrong digest");
    expect(result.digest.parser_status).toBe("unknown"); expect(result.digest.total).toBeNull(); expect(result.digest.unknown_fragment).not.toBeNull();
    expect(Buffer.from(await ledger.readFragment(result.digest.unknown_fragment!.source)).toString("utf8")).toContain("{broken"); ledger.close();
  });

  it("prefers an unrecognized test report on stdout over incidental stderr", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const result = await api.execute(req(base, "test-runner", process.execPath, ["-e", "process.stderr.write('deprecation');process.stdout.write('{broken')"], "unknown-stream"), permit("unknown-stream"));
    if (result.digest.kind !== "test-runner") throw new Error("wrong digest");
    expect(result.digest.unknown_fragment?.source.stream).toBe("stdout"); expect(result.digest.unknown_fragment?.excerpt).toContain("{broken"); ledger.close();
  });

  it("degrades schema-valid test JSON with wrong shapes instead of throwing", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const result = await api.execute(req(base, "test-runner", process.execPath, ["-e", "process.stdout.write(JSON.stringify({numTotalTests:1,testResults:{}}));process.exitCode=1"], "wrong-shape"), permit("wrong-shape"));
    if (result.digest.kind !== "test-runner") throw new Error("wrong digest");
    expect(result.digest.parser_status).toBe("partial"); expect(result.digest.failed_tests).toHaveLength(0); ledger.close();
  });

  it("marks contradictory test counters partial without claiming parsed failures omitted", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const report = JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, testResults: [{ name: "fixture", assertionResults: [{ title: "failed", status: "failed", failureMessages: ["known"] }] }] });
    const result = await api.execute(req(base, "test-runner", process.execPath, ["-e", `process.stdout.write(${JSON.stringify(report)})`], "counter-mismatch"), permit("counter-mismatch"));
    if (result.digest.kind !== "test-runner") throw new Error("wrong digest");
    expect(result.digest.parser_status).toBe("partial"); expect(result.digest.omitted_count).toBe(0); expect(result.digest.truncated).toBe(false); expect(result.digest.failed_tests).toHaveLength(1); ledger.close();
  });

  it("marks a reported failure shortfall as truncated", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const report = JSON.stringify({ numTotalTests: 2, numPassedTests: 0, numFailedTests: 2, numPendingTests: 0, testResults: [{ name: "fixture", assertionResults: [{ title: "failed", status: "failed", failureMessages: ["known"] }] }] });
    const result = await api.execute(req(base, "test-runner", process.execPath, ["-e", `process.stdout.write(${JSON.stringify(report)})`], "counter-shortfall"), permit("counter-shortfall"));
    if (result.digest.kind !== "test-runner") throw new Error("wrong digest");
    expect(result.digest.parser_status).toBe("partial"); expect(result.digest.omitted_count).toBe(1); expect(result.digest.truncated).toBe(true); ledger.close();
  });

  it("rejects non-finite test counters as unknown", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const result = await api.execute(req(base, "test-runner", process.execPath, ["-e", "process.stdout.write('{\"numTotalTests\":1e400,\"testResults\":[]}')"], "infinite-counter"), permit("infinite-counter"));
    if (result.digest.kind !== "test-runner") throw new Error("wrong digest");
    expect(result.digest.parser_status).toBe("unknown"); ledger.close();
  });

  it("bounds an unknown fragment and its source span together", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = createAdapters({ ledger, digestByteLimit: 1200, verifyAndConsumePermit() {} });
    const result = await api.execute(req(base, "test-runner", process.execPath, ["-e", "process.stdout.write(Buffer.concat([Buffer.alloc(126,120),Buffer.from([255]),Buffer.alloc(10000,121)]))"], "unknown-short"), permit("unknown-short"));
    if (result.digest.kind !== "test-runner") throw new Error("wrong digest");
    expect(result.digest.parser_status).toBe("unknown"); expect(result.digest.unknown_fragment).not.toBeNull();
    const fragment = result.digest.unknown_fragment!; expect(fragment.source.byte_end).toBe(128);
    expect(Buffer.from(await ledger.readFragment(fragment.source)).toString("utf8")).toBe(fragment.excerpt); ledger.close();
  });

  it("reduces test-runner primary and derived arrays consistently", async () => {
    const base = root(); const ledger = ledgerAt(base);
    const api = createAdapters({ ledger, digestByteLimit: 1500, verifyAndConsumePermit() {} });
    const result = await api.execute(req(base, "test-runner", process.execPath, ["-e", "const r={numTotalTests:10,numPassedTests:0,numFailedTests:10,numPendingTests:0,testResults:[{name:'fixture',assertionResults:Array.from({length:10},(_,i)=>({title:'failure-'+i,status:'failed',failureMessages:['x'.repeat(100)]}))}]};process.stdout.write(JSON.stringify(r));process.exitCode=1"], "reduce"), permit("reduce"));
    if (result.digest.kind !== "test-runner") throw new Error("wrong digest");
    expect(result.digest.truncated).toBe(true); expect(result.digest.failed_tests).toHaveLength(1); expect(result.digest.failure_signatures).toHaveLength(1); expect(result.digest.omitted_count).toBe(9);
    expect(Buffer.byteLength(JSON.stringify(result.digest), "utf8")).toBeLessThanOrEqual(1500); ledger.close();
  });

  it("counts overlapping shell omissions once during digest reduction", async () => {
    const base = root(); const ledger = ledgerAt(base);
    const api = createAdapters({ ledger, digestByteLimit: 1800, verifyAndConsumePermit() {} });
    const output = Array.from({ length: 8 }, (_, i) => `ERROR ${i}\n`).join("") + Array.from({ length: 8 }, (_, i) => `WARNING ${i}\n`).join("") + "ERROR warning overlap\n";
    const result = await api.execute(req(base, "shell", process.execPath, ["-e", `process.stderr.write(${JSON.stringify(output)})`], "reduce-shell"), permit("reduce-shell"));
    if (result.digest.kind !== "shell") throw new Error("wrong digest");
    expect(result.digest.truncated).toBe(true); expect(result.digest.salient_errors).toHaveLength(1); expect(result.digest.warning_signatures).toHaveLength(2);
    expect(result.digest.omitted_count).toBe(14); expect(Buffer.byteLength(JSON.stringify(result.digest), "utf8")).toBeLessThanOrEqual(1800); ledger.close();
  });

  it("uses the file stream when git-diff output is unknown", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const result = await api.execute(req(base, "git-diff", process.execPath, ["-e", "process.exit(3)"], "unknown-diff"), permit("unknown-diff"));
    expect(result.digest.kind).toBe("git-diff");
    if (result.digest.kind !== "git-diff") throw new Error("wrong digest");
    expect(result.digest.parser_status).toBe("unknown");
    expect(result.digest.unknown_fragment).not.toBeNull();
    await expect(ledger.readFragment(result.digest.unknown_fragment!.source)).resolves.toEqual(new Uint8Array());
    ledger.close();
  });

  it("retains non-empty unknown git-diff output in the file source", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const result = await api.execute(req(base, "git-diff", process.execPath, ["-e", "process.stdout.write('not-a-patch');process.exit(3)"], "unknown-diff-text"), permit("unknown-diff-text"));
    if (result.digest.kind !== "git-diff") throw new Error("wrong digest");
    expect(result.digest.parser_status).toBe("unknown");
    expect(result.digest.unknown_fragment?.excerpt).toContain("not-a-patch");
    expect(result.digest.unknown_fragment?.source.stream).toBe("file");
    await expect(ledger.readFragment(result.digest.unknown_fragment!.source)).resolves.toEqual(new TextEncoder().encode("not-a-patch"));
    ledger.close();
  });

  it("does not recognize non-empty unframed git-diff output on exit 0", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const result = await api.execute(req(base, "git-diff", process.execPath, ["-e", "process.stdout.write('not-a-patch');process.exit(0)"], "unknown-diff-zero"), permit("unknown-diff-zero"));
    if (result.digest.kind !== "git-diff") throw new Error("wrong digest");
    expect(result.digest.parser_status).toBe("unknown");
    expect(result.digest.unknown_fragment).not.toBeNull();
    expect(result.digest.unknown_fragment?.excerpt).toContain("not-a-patch");
    await expect(ledger.readFragment(result.digest.unknown_fragment!.source)).resolves.toEqual(new TextEncoder().encode("not-a-patch"));
    ledger.close();
  });

  it("terminates the child when capture storage fails after consuming streams", async () => {
    const base = root(); const real = ledgerAt(base);
    const broken: EventLedger = {
      ...real,
      async archive(chunks) { for await (const _ of chunks) { /* drain */ } throw new Error("capture storage failed"); },
    };
    const request = req(base, "shell", process.execPath, ["-e", "require('fs').writeFileSync('pid.txt',String(process.pid));process.stdout.end('x');process.stderr.end();setTimeout(()=>require('fs').writeFileSync('late.txt','orphan'),1200);setInterval(()=>{},1000)"], "capture-fail");
    const api = createAdapters({ ledger: broken, digestByteLimit: 4096, verifyAndConsumePermit() {} });
    await expect(api.execute(request, permit("capture-fail"))).rejects.toThrow(/capture storage failed/);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(() => accessSync(`${base}/late.txt`)).toThrow();
    const pid = Number(readFileSync(`${base}/pid.txt`, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    real.close();
  });

  it("reaps a SIGTERM-ignoring child and its pipe-holding descendant", async () => {
    if (process.platform === "win32") throw new Error("BLOCKED: process-group reap falsifier requires POSIX");
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const request = { ...req(base, "shell", process.execPath, ["-e", "const fs=require('fs');const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>require(\\'fs\\').writeFileSync(\\'late-descendant.txt\\',\\'orphan\\'),1200);setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync('descendant.pid',String(c.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], "stubborn"), timeoutMs: 100 };
    let pid: number | undefined;
    try {
      const result = await api.execute(request, permit("stubborn"));
      if (result.digest.kind !== "shell") throw new Error("wrong digest");
      expect(result.digest.termination_signal).toBe("TIMEOUT");
      pid = Number(readFileSync(`${base}/descendant.pid`, "utf8"));
      await expectGone(pid);
      expect(() => accessSync(`${base}/late-descendant.txt`)).toThrow();
    } finally {
      if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ } }
      ledger.close();
    }
  }, 5000);

  it("reaps a pipe-holding descendant after the leader exits", async () => {
    if (process.platform === "win32") throw new Error("BLOCKED: process-group reap falsifier requires POSIX");
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const request = { ...req(base, "shell", process.execPath, ["-e", "const fs=require('fs');const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','process.on(\\'SIGTERM\\',()=>fs.writeFileSync(\\'term-descendant.txt\\',\\'term\\'));setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync('descendant.pid',String(c.pid));process.exit(0)"], "leader-exits"), timeoutMs: 500 };
    let pid: number | undefined;
    try {
      const result = await api.execute(request, permit("leader-exits"));
      if (result.digest.kind !== "shell") throw new Error("wrong digest");
      expect(result.digest.termination_signal).toBe("TIMEOUT");
      pid = Number(readFileSync(`${base}/descendant.pid`, "utf8"));
      expect(readFileSync(`${base}/term-descendant.txt`, "utf8")).toBe("term");
      await expectGone(pid);
    } finally {
      if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ } }
      ledger.close();
    }
  }, 7000);

  it("compiler parses a real tsc diagnostic and resolves source handle", async () => {
    const base = root(); writeFileSync(join(base, "bad.ts"), "const x: number = 'no';\n");
    const ledger = ledgerAt(base); const api = adapters(ledger); const tsc = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
    const result = await api.execute(req(base, "compiler", process.execPath, [tsc, "--pretty", "false", "--noEmit", "bad.ts"], "tsc"), permit("tsc"));
    if (result.digest.kind !== "compiler") throw new Error("wrong digest");
    expect(result.digest.error_count).toBeGreaterThan(0); expect(result.digest.diagnostics[0]?.code).toMatch(/^TS/);
    expect(Buffer.from(await ledger.readFragment(result.digest.diagnostics[0]!.source)).toString("utf8")).toContain("TS"); ledger.close();
  });

  it("preserves continuation lines in multiline compiler diagnostics", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const script = "process.stderr.write('file.ts(1,1): error TS9999: first line\\n  continuation detail\\nfile.ts(2,1): warning TS9998: second line\\n')";
    const result = await api.execute(req(base, "compiler", process.execPath, ["-e", script], "multiline"), permit("multiline"));
    if (result.digest.kind !== "compiler") throw new Error("wrong digest");
    expect(result.digest.diagnostics).toHaveLength(2);
    expect(result.digest.diagnostics[0]!.message).toContain("continuation detail");
    const raw = Buffer.from(await ledger.readFragment(result.digest.diagnostics[0]!.source)).toString("utf8");
    expect(raw).toContain("continuation detail"); expect(raw).not.toContain("TS9998"); ledger.close();
  });

  it("recognizes locationless compiler diagnostics", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const script = "process.stderr.write('error TS2688: global issue\\nfile.ts(2,1): warning TS9998: located issue\\n')";
    const result = await api.execute(req(base, "compiler", process.execPath, ["-e", script], "locationless"), permit("locationless"));
    if (result.digest.kind !== "compiler") throw new Error("wrong digest");
    expect(result.digest.diagnostics).toHaveLength(2); expect(result.digest.diagnostics[0]!.file).toBeNull(); expect(result.digest.diagnostics[0]!.code).toBe("TS2688"); ledger.close();
  });

  it("keeps compiler source resolvable when raw output has invalid UTF-8", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const script = "process.stderr.write(Buffer.from([255]));process.stderr.write('\\nfile.ts(1,1): error TS9999: invalid\\n')";
    const result = await api.execute(req(base, "compiler", process.execPath, ["-e", script], "invalid-utf8"), permit("invalid-utf8"));
    if (result.digest.kind !== "compiler") throw new Error("wrong digest");
    expect(result.digest.diagnostics).toHaveLength(1);
    const raw = await ledger.readFragment(result.digest.diagnostics[0]!.source);
    expect(raw[0]).toBe(255); expect(Buffer.from(raw).toString("utf8")).toContain("TS9999"); ledger.close();
  });

  it("marks overflowing compiler coordinates partial", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const script = `process.stderr.write('file.ts(${"9".repeat(400)},1): error TS9999: huge coordinate\\n')`;
    const result = await api.execute(req(base, "compiler", process.execPath, ["-e", script], "huge-coordinate"), permit("huge-coordinate"));
    if (result.digest.kind !== "compiler") throw new Error("wrong digest");
    expect(result.digest.parser_status).toBe("partial"); expect(result.digest.diagnostics[0]!.line).toBeNull(); ledger.close();
  });

  it("bounds a single oversized compiler diagnostic without turning execution unknown", async () => {
    const base = root(); const ledger = ledgerAt(base);
    const api = createAdapters({ ledger, digestByteLimit: 1800, verifyAndConsumePermit() {} });
    const script = `process.stderr.write('file.ts(1,1): error TS9999: ${"x".repeat(20000)}\\n')`;
    const result = await api.execute(req(base, "compiler", process.execPath, ["-e", script], "large-diagnostic"), permit("large-diagnostic"));
    expect(Buffer.byteLength(JSON.stringify(result.digest), "utf8")).toBeLessThanOrEqual(1800);
    expect(result.digest.truncated).toBe(true);
    if (result.digest.kind !== "compiler") throw new Error("wrong digest");
    expect(result.digest.diagnostics).toHaveLength(1);
    expect(result.digest.diagnostics[0]!.message.length).toBeLessThan(20000);
    ledger.close();
  });

  it("bounds a large changed-artifact set and records omitted artifacts", async () => {
    const base = root(); const ledger = ledgerAt(base);
    const dependencyPaths = Array.from({ length: 24 }, (_, i) => `artifact-${i}.txt`);
    const script = "const fs=require('fs');for(let i=0;i<24;i++)fs.writeFileSync(`artifact-${i}.txt`,'x')";
    const api = createAdapters({ ledger, digestByteLimit: 1800, verifyAndConsumePermit() {} });
    const result = await api.execute(req(base, "shell", process.execPath, ["-e", script], "large-artifacts", dependencyPaths), permit("large-artifacts"));
    expect(Buffer.byteLength(JSON.stringify(result.digest), "utf8")).toBeLessThanOrEqual(1800);
    if (result.digest.kind !== "shell") throw new Error("wrong digest");
    expect(result.digest.changed_artifacts).toHaveLength(1);
    expect(result.digest.omitted_count).toBeGreaterThanOrEqual(23);
    expect(result.digest.truncated).toBe(true);
    ledger.close();
  });

  it("git-diff uses NUL framing for rename, binary, tab and newline filenames", async () => {
    const base = root(); execFileSync("git", ["init", "-q"], { cwd: base }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: base }); execFileSync("git", ["config", "user.name", "Test"], { cwd: base });
    writeFileSync(join(base, "old.txt"), "a\n"); writeFileSync(join(base, "tab\tname.txt"), "x\n"); writeFileSync(join(base, "line\nname.txt"), "n\n"); writeFileSync(join(base, "bin.dat"), Buffer.from([0,1,2,0,255]));
    execFileSync("git", ["add", "-A"], { cwd: base }); execFileSync("git", ["commit", "-qm", "base"], { cwd: base });
    execFileSync("git", ["mv", "old.txt", "new.txt"], { cwd: base }); writeFileSync(join(base, "tab\tname.txt"), "x\ny\n"); writeFileSync(join(base, "line\nname.txt"), "n\nm\n"); writeFileSync(join(base, "bin.dat"), Buffer.from([0,9,8,0,255])); execFileSync("git", ["add", "-A"], { cwd: base }); execFileSync("git", ["commit", "-qm", "head"], { cwd: base });
    const ledger = ledgerAt(base); const api = adapters(ledger);
    const argv = ["diff", "--raw", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "-M", "HEAD~1", "HEAD"];
    const result = await api.execute(req(base, "git-diff", "git", argv, "diff"), permit("diff"));
    if (result.digest.kind !== "git-diff") throw new Error("wrong digest");
    expect(result.digest.file_summaries.some((f) => f.status === "R" && f.old_path === "old.txt" && f.path === "new.txt")).toBe(true);
    expect(result.digest.binary_files).toContain("bin.dat"); expect(result.digest.file_summaries.some((f) => f.path.includes("\t"))).toBe(true); expect(result.digest.file_summaries.some((f) => f.path.includes("\n"))).toBe(true);
    const handle = result.digest.file_summaries[0]!.patch_source; expect((await ledger.readFragment(handle)).byteLength).toBeGreaterThan(0); ledger.close();
  });

  it("does not treat a pathspec after -- as the git-diff head ref", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const output = "1\t0\t123-pathspec.txt\0";
    const argv = ["diff", "--raw", "--numstat", "-z", "HEAD~1", "HEAD", "--", "123-pathspec.txt"];
    const result = await api.execute(req(base, "git-diff", process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)})`, ...argv], "diff-pathspec"), permit("diff-pathspec"));
    if (result.digest.kind !== "git-diff") throw new Error("wrong digest");
    expect(result.digest.base).toBe("HEAD~1");
    expect(result.digest.head).toBe("HEAD");
    ledger.close();
  });

  it("marks overflowing git numstat counts partial", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const huge = "9".repeat(400);
    const result = await api.execute(req(base, "git-diff", process.execPath, ["-e", `process.stdout.write(${JSON.stringify(`0\t${huge}\tfile.txt\0`)})`], "huge-stat"), permit("huge-stat"));
    if (result.digest.kind !== "git-diff") throw new Error("wrong digest");
    expect(result.digest.parser_status).toBe("partial"); expect(result.digest.file_summaries[0]!.deletions).toBeNull(); ledger.close();
  });

  it("100 KB shell log preserves raw and bounds digest", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const result = await api.execute(req(base, "shell", process.execPath, ["-e", "process.stdout.write('x'.repeat(100*1024))"], "large"), permit("large"));
    expect(result.rawBlobs[0]!.bytes).toBeGreaterThanOrEqual(100 * 1024); expect(Buffer.byteLength(JSON.stringify(result.digest), "utf8")).toBeLessThanOrEqual(4096); ledger.close();
  });

  it("timeout and signal termination are captured without shell invocation", async () => {
    const base = root(); const ledger = ledgerAt(base); const api = adapters(ledger);
    const timeoutRequest = { ...req(base, "shell", process.execPath, ["-e", "setTimeout(()=>{},10000)"], "timeout"), timeoutMs: 100 };
    const timed = await api.execute(timeoutRequest, permit("timeout"));
    if (timed.digest.kind !== "shell") throw new Error("wrong digest"); expect(timed.digest.termination_signal).toBe("TIMEOUT");
    const signaled = await api.execute(req(base, "shell", process.execPath, ["-e", "process.kill(process.pid,'SIGTERM')"], "signal"), permit("signal"));
    if (signaled.digest.kind !== "shell") throw new Error("wrong digest"); expect(signaled.digest.termination_signal).toBe("SIGTERM"); ledger.close();
  });

  it("append failure prevents digest admission", async () => {
    const base = root(); const real = ledgerAt(base);
    const broken: EventLedger = { ...real, append() { throw new Error("append failed"); } };
    const api = createAdapters({ ledger: broken, digestByteLimit: 4096, verifyAndConsumePermit() {} });
    await expect(api.execute(req(base, "shell", process.execPath, ["-e", "process.stdout.write('x')"], "append-fail"), permit("append-fail"))).rejects.toThrow(/append failed/);
    real.close();
  });

});
