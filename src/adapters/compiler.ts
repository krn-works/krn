import type { CapturedProcess, CompilerDigest } from "./types.js";
import { commandPreview } from "./shell.js";

function validUtf8(bytes: Uint8Array): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; }
  catch { return false; }
}
function coordinate(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function source(process: CapturedProcess, stream: "stdout" | "stderr", text: string, bytes: Uint8Array, rawIsUtf8: boolean, index: number, length: number) {
  const receipt = stream === "stdout" ? process.stdoutReceipt : process.stderrReceipt;
  if (!rawIsUtf8) {
    // Replacement characters change decoded string length. Keep the handle
    // honest by exposing the complete raw stream when precise offsets cannot
    // be derived from invalid UTF-8.
    return {
      event_id: process.rawEventId, blob_hash: receipt.hash, stream,
      byte_start: 0, byte_end: bytes.byteLength,
    } as const;
  }
  return {
    event_id: process.rawEventId, blob_hash: receipt.hash, stream,
    byte_start: Buffer.byteLength(text.slice(0, index), "utf8"),
    byte_end: Buffer.byteLength(text.slice(0, index + length), "utf8"),
  } as const;
}

export function compilerDigest(process: CapturedProcess): CompilerDigest {
  const outputs = [
    { stream: "stdout" as const, bytes: process.stdout, text: Buffer.from(process.stdout).toString("utf8"), rawIsUtf8: validUtf8(process.stdout) },
    { stream: "stderr" as const, bytes: process.stderr, text: Buffer.from(process.stderr).toString("utf8"), rawIsUtf8: validUtf8(process.stderr) },
  ];
  const diagnostics: CompilerDigest["diagnostics"][number][] = [];
  let invalidCoordinate = false;
  const regex = /^(?:(.*?)(?:\((\d+),(\d+)\))?:\s+)?(error|warning)\s+(TS\d+):\s*([\s\S]*?)(?=\n(?:(?:.*?)(?:\(\d+,\d+\))?:\s+)?(?:error|warning)\s+TS\d+:|(?![\s\S]))/gm;
  for (const output of outputs) {
    for (const match of output.text.matchAll(regex)) {
      const full = match[0]; const index = match.index ?? 0;
      const line = coordinate(match[2]);
      const column = coordinate(match[3]);
      if ((match[2] !== undefined && line === null) || (match[3] !== undefined && column === null)) invalidCoordinate = true;
      diagnostics.push({
        severity: match[4] === "warning" ? "warning" : "error",
        code: match[5] ?? null,
        file: (match[1] ?? "").trim() || null,
        line,
        column,
        message: (match[6] ?? "").trim().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""),
        source: source(process, output.stream, output.text, output.bytes, output.rawIsUtf8, index, full.length),
      });
    }
  }
  const recognized = diagnostics.length > 0 || process.exitCode === 0;
  const errorCount = recognized ? diagnostics.filter((item) => item.severity === "error").length : null;
  const warningCount = recognized ? diagnostics.filter((item) => item.severity === "warning").length : null;
  return {
    kind: "compiler", adapter_version: "compiler/tsc-v1", raw_event_id: process.rawEventId, receipt_id: process.rawEventId,
    capture_complete: process.stdoutReceipt.complete && process.stderrReceipt.complete,
    parser_status: recognized ? invalidCoordinate ? "partial" : "recognized" : "unknown", omitted_count: 0, truncated: false, unknown_fragment: null,
    compiler: process.request.executable, command: commandPreview(process.request), exit_code: process.exitCode,
    error_count: errorCount, warning_count: warningCount, diagnostics,
    affected_files: [...new Set(diagnostics.flatMap((item) => item.file === null ? [] : [item.file]))],
    compiled_epoch: process.request.goalId,
  };
}
