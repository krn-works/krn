// Measures cache writes after idle gaps in Claude Code session transcripts (JSONL).
// Usage: node scripts/idle-gap-cache.mjs <dir-with-jsonl> [ttlSeconds=3600]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Parse one transcript line into a turn record, or null when it carries no usage. */
export function parseLine(line) {
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (d.type === 'system' && d.subtype === 'compact_boundary') {
    const m = d.compactMetadata ?? {};
    return {
      kind: 'compact',
      ts: Date.parse(d.timestamp),
      trigger: m.trigger,
      pre: m.preTokens,
      post: m.postTokens,
    };
  }
  const u = d.message?.usage;
  if (d.type !== 'assistant' || !u || d.isSidechain)
    return { kind: 'msg', ts: Date.parse(d.timestamp) };
  return {
    kind: 'turn',
    ts: Date.parse(d.timestamp),
    id: d.requestId ?? d.message?.id,
    write: u.cache_creation_input_tokens ?? 0,
    read: u.cache_read_input_tokens ?? 0,
    fresh: u.input_tokens ?? 0,
  };
}

/** Per-session stats: turns whose preceding gap exceeds the TTL and what they re-wrote. */
export function analyze(records, ttlSec) {
  const out = {
    turns: 0,
    write: 0,
    read: 0,
    gaps: 0,
    gapWrite: 0,
    gapCtx: 0,
    compacts: 0,
    compactAuto: 0,
    compactPost: 0,
  };
  let prev = null;
  const seen = new Set();
  for (const r of records) {
    if (!r || Number.isNaN(r.ts)) continue;
    if (r.kind === 'compact') {
      out.compacts++;
      if (r.trigger === 'auto') out.compactAuto++;
      out.compactPost += r.post ?? 0;
    }
    if (r.kind === 'turn') {
      if (seen.has(r.id)) {
        prev = r.ts;
        continue;
      } // streamed duplicate of same request
      seen.add(r.id);
      out.turns++;
      out.write += r.write;
      out.read += r.read;
      if (prev !== null && (r.ts - prev) / 1000 > ttlSec) {
        out.gaps++;
        out.gapWrite += r.write;
        out.gapCtx += r.write + r.read + r.fresh;
      }
    }
    prev = r.ts;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  const ttl = Number(process.argv[3] ?? 3600);
  const tot = {};
  const rows = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    const s = analyze(
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(parseLine),
      ttl,
    );
    rows.push([f.slice(0, 8), s]);
    for (const [k, v] of Object.entries(s)) tot[k] = (tot[k] ?? 0) + v;
  }
  console.log(JSON.stringify({ ttl, sessions: rows.length, ...tot }));
  for (const [id, s] of rows
    .sort((a, b) => b[1].gapWrite - a[1].gapWrite)
    .slice(0, 5))
    console.log(id, JSON.stringify(s));
}
