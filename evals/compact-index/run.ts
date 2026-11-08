// Offline replay of local Claude compaction boundaries: does the identifier index recall the
// identifiers the next tool calls use, compared with the compaction summary alone?
// Usage: node evals/compact-index/run.ts [--root <project>] [--all] [--transcripts <dir>...]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildIndex,
  extractIdentifiers,
  isBoundary,
  mentionsOf,
  parseTranscript,
  rankIdentifiers,
} from '../../scripts/claude/identifier-index.ts';

// Window of tool calls after a boundary: at least `minCalls`, at most `maxCalls`.
export const minCalls = 3;
export const maxCalls = 8;

export type BoundaryScore = {
  transcript: string;
  boundary: number;
  calls: number;
  targets: number;
  indexHits: number;
  summaryHits: number;
  blockBytes: number;
};

function keys(text: string, root: string): Set<string> {
  return new Set(
    extractIdentifiers(text, root).map((id) => `${id.kind}:${id.value}`),
  );
}

export function scoreTranscript(
  raw: string,
  root: string,
  name = '',
): BoundaryScore[] {
  const entries = parseTranscript(raw);
  const scores: BoundaryScore[] = [];
  entries.forEach((entry, boundary) => {
    if (!isBoundary(entry)) return;
    const before = entries.slice(0, boundary).flatMap(mentionsOf);
    const seen = keys(before.map((m) => m.text).join('\n'), root);
    const { text: block, chosen } = buildIndex(rankIdentifiers(before, root));
    const indexed = new Set(chosen.map((id) => `${id.kind}:${id.value}`));
    let summary = '';
    const calls: string[] = [];
    for (const next of entries.slice(boundary + 1)) {
      if (isBoundary(next)) break;
      if (next.isCompactSummary === true && !summary)
        summary = mentionsOf(next)
          .map((m) => m.text)
          .join('\n');
      for (const mention of mentionsOf(next))
        if (mention.source === 'call' && calls.length < maxCalls)
          calls.push(mention.text);
      if (calls.length >= maxCalls) break;
    }
    if (calls.length < minCalls) return;
    const summarized = keys(summary, root);
    const targets = [...keys(calls.join('\n'), root)].filter((key) =>
      seen.has(key),
    );
    scores.push({
      transcript: name,
      boundary,
      calls: calls.length,
      targets: targets.length,
      indexHits: targets.filter((key) => indexed.has(key)).length,
      summaryHits: targets.filter((key) => summarized.has(key)).length,
      blockBytes: Buffer.byteLength(block),
    });
  });
  return scores;
}

export function aggregate(scores: BoundaryScore[]) {
  const scored = scores.filter((score) => score.targets > 0);
  const sum = (pick: (s: BoundaryScore) => number) =>
    scored.reduce((total, s) => total + pick(s), 0);
  const targets = sum((s) => s.targets);
  return {
    boundaries: scored.length,
    targets,
    indexRecall: targets ? sum((s) => s.indexHits) / targets : 0,
    summaryRecall: targets ? sum((s) => s.summaryHits) / targets : 0,
    maxBlockBytes: Math.max(0, ...scores.map((s) => s.blockBytes)),
  };
}

// Claude project directories of this checkout and its worktrees; `all` takes every project.
function projectDirectories(root: string, all: boolean): string[] {
  const slug = root.replace(/[^a-zA-Z0-9]/gu, '-');
  const base = join(homedir(), '.claude/projects');
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter(
      (name) =>
        all || name === slug || name.startsWith(`${slug}--krn-worktrees-`),
    )
    .map((name) => join(base, name));
}

// Every transcript below a directory, subagent transcripts included.
function transcripts(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...transcripts(path));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path);
  }
  return out.sort();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const root = resolve(option('--root') ?? process.cwd());
  const directories = args.includes('--transcripts')
    ? args.slice(args.indexOf('--transcripts') + 1)
    : projectDirectories(root, args.includes('--all'));
  const scores: BoundaryScore[] = [];
  for (const directory of directories)
    for (const path of transcripts(directory)) {
      const raw = readFileSync(path, 'utf8');
      if (raw.includes('"compact_boundary"'))
        scores.push(...scoreTranscript(raw, root, path));
    }
  const result = aggregate(scores);
  const pass =
    result.boundaries >= 15 &&
    result.indexRecall >= 0.7 &&
    result.maxBlockBytes <= 1500;
  process.stdout.write(
    `${JSON.stringify({ ...result, verdict: pass ? 'PASS' : 'FAIL', scores }, null, 1)}\n`,
  );
  process.exitCode = pass ? 0 : 1;
}
