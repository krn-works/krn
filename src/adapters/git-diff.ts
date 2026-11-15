import type { CapturedProcess, GitDiffDigest } from "./types.js";

function refs(argv: readonly string[]): { base: string; head: string } {
  const diffIndex = argv.indexOf("diff");
  const args = diffIndex >= 0 ? argv.slice(diffIndex + 1) : argv;
  const separator = args.indexOf("--");
  const revisionArgs = separator >= 0 ? args.slice(0, separator) : args;
  const values = revisionArgs.filter((value) => !value.startsWith("-"));
  return values.length === 2 ? { base: values[0]!, head: values[1]! } : { base: "", head: "" };
}

function patchHandle(process: CapturedProcess) {
  return { event_id: process.rawEventId, blob_hash: process.stdoutReceipt.hash, stream: "file" as const, byte_start: 0, byte_end: process.stdoutReceipt.bytes };
}
function statCount(value: string): number | null {
  if (value === "-") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function gitDiffDigest(process: CapturedProcess): GitDiffDigest {
  const tokens = Buffer.from(process.stdout).toString("utf8").split("\0");
  const summaries: GitDiffDigest["file_summaries"][number][] = [];
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  const binary = new Set<string>();
  let invalidStat = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    const stat = token.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!stat) continue;
    const additions = statCount(stat[1]!);
    const deletions = statCount(stat[2]!);
    if ((stat[1] !== "-" && additions === null) || (stat[2] !== "-" && deletions === null)) invalidStat = true;
    const embedded = stat[3] ?? "";
    if (embedded !== "") {
      stats.set(embedded, { additions, deletions });
      if (stat[1] === "-" || stat[2] === "-") binary.add(embedded);
      continue;
    }
    const first = tokens[++i] ?? "";
    const next = tokens[i + 1] ?? "";
    if (next !== "" && !/^[:\d-]/.test(next)) {
      const second = tokens[++i] ?? "";
      stats.set(first, { additions, deletions });
      stats.set(second, { additions, deletions });
      if (stat[1] === "-" || stat[2] === "-") { binary.add(first); binary.add(second); }
    } else {
      stats.set(first, { additions, deletions });
      if (stat[1] === "-" || stat[2] === "-") binary.add(first);
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const raw = (tokens[i] ?? "").match(/^:[0-7]{6}\s+[0-7]{6}\s+[0-9a-f]+\s+[0-9a-f]+\s+([AMDRCT])(\d+)?$/i);
    if (!raw) continue;
    const status = raw[1]! as "A" | "M" | "D" | "R" | "C" | "T";
    const first = tokens[++i] ?? "";
    const second = status === "R" || status === "C" ? tokens[++i] ?? "" : null;
    const path = second ?? first;
    const stat = stats.get(path) ?? stats.get(first) ?? { additions: null, deletions: null };
    summaries.push({ path, old_path: second === null ? null : first, status, additions: stat.additions, deletions: stat.deletions, patch_source: patchHandle(process) });
  }

  if (summaries.length === 0) {
    for (const [path, stat] of stats) summaries.push({ path, old_path: null, status: "M", additions: stat.additions, deletions: stat.deletions, patch_source: patchHandle(process) });
  }

  const { base, head } = refs(process.request.argv);
  const hasOutput = process.stdoutReceipt.bytes > 0;
  const hasParsedFiles = summaries.length > 0;
  const parser_status = invalidStat
    ? "partial"
    : hasOutput
      ? hasParsedFiles
        ? "recognized"
        : "unknown"
      : process.exitCode === 0
        ? "recognized"
        : "unknown";
  return {
    kind: "git-diff", adapter_version: "git-diff/v1", raw_event_id: process.rawEventId, receipt_id: process.rawEventId,
    capture_complete: process.stdoutReceipt.complete && process.stderrReceipt.complete,
    parser_status,
    omitted_count: 0, truncated: false, unknown_fragment: null, base, head,
    files_changed: summaries.length,
    additions: summaries.reduce((sum, item) => sum + (item.additions ?? 0), 0),
    deletions: summaries.reduce((sum, item) => sum + (item.deletions ?? 0), 0),
    file_summaries: summaries, binary_files: [...new Set([...binary].filter((path) => summaries.some((item) => item.path === path || item.old_path === path)))],
  };
}
