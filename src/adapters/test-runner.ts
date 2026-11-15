import type { CapturedProcess, TestRunnerDigest } from "./types.js";
import { commandPreview, sha256 } from "./shell.js";

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value); }
function countOrNull(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }

function validUtf8(bytes: Uint8Array): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; }
  catch { return false; }
}

export function testRunnerDigest(process: CapturedProcess): TestRunnerDigest {
  const stdout = Buffer.from(process.stdout).toString("utf8");
  let rawReport: unknown = null;
  try { rawReport = JSON.parse(stdout); } catch { rawReport = null; }
  const report: JsonRecord | null = isRecord(rawReport) ? rawReport : null;
  const recognized = report !== null && countOrNull(report.numTotalTests) !== null;
  const totals = recognized ? {
    total: countOrNull(report.numTotalTests),
    passed: countOrNull(report.numPassedTests),
    failed: countOrNull(report.numFailedTests),
    skipped: countOrNull(report.numPendingTests),
  } : { total: null, passed: null, failed: null, skipped: null };
  let parser_status: TestRunnerDigest["parser_status"] = recognized ? "recognized" : "unknown";
  if (recognized && (totals.total === null || totals.passed === null || totals.failed === null || totals.skipped === null)) parser_status = "partial";
  const failed_tests: TestRunnerDigest["failed_tests"][number][] = [];
  let omitted_count = 0;
  let searchOffset = 0;
  if (recognized) {
    const rawIsUtf8 = validUtf8(process.stdout);
    const testResults = report.testResults;
    if (!Array.isArray(testResults)) parser_status = "partial";
    for (const rawFile of Array.isArray(testResults) ? testResults : []) {
      if (!isRecord(rawFile)) { parser_status = "partial"; continue; }
      const fileName = typeof rawFile.name === "string" ? rawFile.name : "";
      if (rawFile.name !== undefined && typeof rawFile.name !== "string") parser_status = "partial";
      if (!Array.isArray(rawFile.assertionResults)) { parser_status = "partial"; continue; }
      for (const rawAssertion of rawFile.assertionResults) {
        if (!isRecord(rawAssertion)) { parser_status = "partial"; continue; }
        const ancestorsValue = rawAssertion.ancestorTitles;
        const ancestors = Array.isArray(ancestorsValue) ? ancestorsValue.filter((value): value is string => typeof value === "string") : [];
        if (ancestorsValue !== undefined && (!Array.isArray(ancestorsValue) || ancestors.length !== ancestorsValue.length)) parser_status = "partial";
        const titleValue = rawAssertion.title;
        const title = typeof titleValue === "string" ? titleValue : "";
        if (titleValue !== undefined && typeof titleValue !== "string") parser_status = "partial";
        const name = [...ancestors, title].filter(Boolean).join(" > ");
        const serializedTitle = JSON.stringify(title);
        const escapedTitle = serializedTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const field = new RegExp(`"title"\\s*:\\s*${escapedTitle}`, "g");
        field.lastIndex = searchOffset;
        const match = field.exec(stdout);
        const idx = match?.index ?? -1;
        const valueStart = match === null || match === undefined ? idx : idx + match[0].lastIndexOf(serializedTitle) + 1;
        const rawTitle = match === null || match === undefined ? title : serializedTitle.slice(1, -1);
        if (idx >= 0) searchOffset = idx + Math.max(match?.[0].length ?? title.length, 1);
        const status = typeof rawAssertion.status === "string" ? rawAssertion.status : "";
        if (rawAssertion.status !== undefined && typeof rawAssertion.status !== "string") parser_status = "partial";
        const failureMessagesValue = rawAssertion.failureMessages;
        const failureMessages = Array.isArray(failureMessagesValue) ? failureMessagesValue.filter((value): value is string => typeof value === "string") : [];
        if (failureMessagesValue !== undefined && (!Array.isArray(failureMessagesValue) || failureMessages.length !== failureMessagesValue.length)) parser_status = "partial";
        if (status !== "failed") continue;
        const marker = failureMessages[0] ?? name;
        // A missing title means the report cannot be located structurally. Use
        // the complete raw report as the honest evidence span and mark parsing
        // partial instead of fabricating an unrelated 0..256 range.
        if (idx < 0) parser_status = "partial";
        const start = idx >= 0 && rawIsUtf8 ? Buffer.byteLength(stdout.slice(0, valueStart), "utf8") : 0;
        const end = idx >= 0 ? start + Buffer.byteLength(rawTitle, "utf8") : process.stdoutReceipt.bytes;
        const sourceStart = rawIsUtf8 ? start : 0;
        const sourceEnd = rawIsUtf8 ? end : process.stdoutReceipt.bytes;
        failed_tests.push({
          test_id: sha256(`${fileName}\0${name}`), file: fileName, name,
          signature: sha256(marker),
          source: { event_id: process.rawEventId, blob_hash: process.stdoutReceipt.hash, stream: "stdout", byte_start: sourceStart, byte_end: sourceEnd },
        });
      }
    }
    if (!rawIsUtf8 && failed_tests.length > 0) parser_status = "partial";
    if ((process.exitCode === 0 && (totals.failed ?? 0) > 0) || (process.exitCode !== 0 && totals.failed === 0)) parser_status = "partial";
    if (totals.failed !== null && totals.failed !== failed_tests.length) {
      parser_status = "partial";
      omitted_count += Math.max(0, totals.failed - failed_tests.length);
    }
  }
  return {
    kind: "test-runner", adapter_version: "test-runner/vitest-json-v1", raw_event_id: process.rawEventId, receipt_id: process.rawEventId,
    capture_complete: process.stdoutReceipt.complete && process.stderrReceipt.complete, parser_status,
    omitted_count, truncated: omitted_count > 0, unknown_fragment: null, framework: "vitest", command: commandPreview(process.request), exit_code: process.exitCode,
    ...totals, failed_tests, failure_signatures: failed_tests.map((item) => item.signature), duration_ms: process.durationMs,
    tested_epoch: process.request.goalId,
    test_fingerprint: sha256(JSON.stringify({ executable: process.request.executable, argv: process.request.argv, cwd: process.request.cwd })),
  };
}
