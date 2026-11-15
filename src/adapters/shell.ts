import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { CapturedProcess, ExecutionRequest, ShellDigest } from "./types.js";

const VERSION = "shell/v1";
export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function commandPreview(request: ExecutionRequest): string {
  const text = [request.executable, ...request.argv].join(" ");
  if (Buffer.byteLength(text, "utf8") <= 512) return text;
  const bytes = Buffer.from(text, "utf8");
  for (let end = Math.min(509, bytes.byteLength); end >= 0; end -= 1) {
    try { return new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, end)) + "..."; }
    catch { /* back up to a complete UTF-8 sequence */ }
  }
  return "...";
}
export function argsHash(request: ExecutionRequest): string {
  return sha256(JSON.stringify({ executable: request.executable, argv: request.argv }));
}
export async function fileHash(cwd: string, path: string): Promise<string | "MISSING"> {
  try { return sha256(await readFile(isAbsolute(path) ? path : resolve(cwd, path))); }
  catch { return "MISSING"; }
}
export async function measureDependencies(request: ExecutionRequest): Promise<Readonly<Record<string, string | "MISSING">>> {
  const pairs = await Promise.all(request.dependencyPaths.map(async (path) => [path, await fileHash(request.cwd, path)] as const));
  return Object.fromEntries(pairs);
}
function handle(process: CapturedProcess, stream: "stdout" | "stderr", start: number, end: number) {
  const receipt = stream === "stdout" ? process.stdoutReceipt : process.stderrReceipt;
  return { event_id: process.rawEventId, blob_hash: receipt.hash, stream, byte_start: start, byte_end: end } as const;
}
function* rawLines(bytes: Uint8Array): Generator<{ text: string; start: number; end: number }> {
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const end = index + 1;
    yield { text: Buffer.from(bytes.subarray(start, end)).toString("utf8"), start, end };
    start = end;
  }
  if (start < bytes.byteLength) yield { text: Buffer.from(bytes.subarray(start)).toString("utf8"), start, end: bytes.byteLength };
}
export function shellDigest(process: CapturedProcess, before: Readonly<Record<string, string | "MISSING">>, after: Readonly<Record<string, string | "MISSING">>): ShellDigest {
  const candidates: { text: string; stream: "stdout" | "stderr"; offset: number; rawLength: number }[] = [];
  const warningMatches: { signature: string }[] = [];
  let errorRank = 0;
  let warningRank = 0;
  let omitted_count = 0;
  for (const [bytes, stream] of [[process.stderr, "stderr"], [process.stdout, "stdout"]] as const) {
    for (const line of rawLines(bytes)) {
      const text = line.text;
      const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd();
      const isError = /\b(error|fatal|failed|exception)\b/i.test(clean);
      const isWarning = stream === "stderr" && /\bwarning\b/i.test(text);
      if (isError) {
        errorRank += 1;
        if (errorRank <= 8) candidates.push({ text: clean.slice(0, 512), stream, offset: line.start, rawLength: line.end - line.start });
      }
      if (isWarning) {
        warningRank += 1;
        if (warningMatches.length < 8) warningMatches.push({ signature: sha256(text.trimEnd()) });
      }
      // Count distinct raw lines omitted from both views. A line retained by
      // either view is represented, even when it matches both patterns.
      const retained = (isError && errorRank <= 8) || (isWarning && warningRank <= 8);
      if ((isError || isWarning) && !retained) omitted_count += 1;
    }
  }
  const salient_errors = candidates.map((item) => {
    // Keep the handle over the original raw line. The excerpt is cleaned for
    // context, while ANSI escapes and multibyte text make its byte span differ
    // from the raw source span.
    return { signature: sha256(item.text), code: null, excerpt: item.text, source: handle(process, item.stream, item.offset, item.offset + item.rawLength) };
  });
  const warning_signatures = warningMatches.map(match => match.signature);
  const changed_artifacts = process.request.dependencyPaths.flatMap((path) => before[path] !== after[path]
    ? [{ path, before: before[path] ?? "MISSING", after: after[path] ?? "MISSING" }]
    : []);
  return {
    kind: "shell", adapter_version: VERSION, raw_event_id: process.rawEventId, receipt_id: process.rawEventId,
    capture_complete: process.stdoutReceipt.complete && process.stderrReceipt.complete,
    parser_status: "recognized", omitted_count, truncated: omitted_count > 0, unknown_fragment: null,
    command: commandPreview(process.request), normalized_args_hash: argsHash(process.request),
    exit_code: process.exitCode, termination_signal: process.signal, duration_ms: process.durationMs,
    stdout_bytes: process.stdoutReceipt.bytes, stderr_bytes: process.stderrReceipt.bytes,
    salient_errors, warning_signatures, changed_artifacts,
  };
}
