import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEFAULT_METRICS } from './ctx-proxy.ts';

type Row = {
  session: string;
  input: number;
  wouldClear: number;
  cold: boolean;
};

const n = (v: unknown): number => (typeof v === 'number' ? v : 0);

export function parseMetrics(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof doc !== 'object' || doc === null) continue;
    const r = doc as Record<string, unknown>;
    rows.push({
      session: typeof r.session === 'string' ? r.session : '?',
      input:
        n(r.input_tokens) + n(r.cache_read_tokens) + n(r.cache_creation_tokens),
      wouldClear: n(r.would_clear_tokens),
      cold: r.cold === true,
    });
  }
  return rows;
}

// Clearing edits the prefix and so breaks the cache; it pays only when the
// cache is already cold. The saving is the would_clear tokens of those requests.
export function report(rows: Row[]): string[] {
  const sessions = new Map<string, Row[]>();
  for (const row of rows) {
    sessions.set(row.session, [...(sessions.get(row.session) ?? []), row]);
  }
  const out = [
    'session requests input_tokens would_clear_tokens cold_share saving_if_cold_only',
  ];
  let requests = 0;
  let input = 0;
  let saving = 0;
  let cold = 0;
  for (const [session, list] of sessions) {
    const coldRows = list.filter((r) => r.cold);
    const sIn = list.reduce((a, r) => a + r.input, 0);
    const sClear = list.reduce((a, r) => a + r.wouldClear, 0);
    const sSave = coldRows.reduce((a, r) => a + r.wouldClear, 0);
    out.push(
      `${session} ${list.length} ${sIn} ${sClear} ${((coldRows.length / list.length) * 100).toFixed(1)}% ${sSave}`,
    );
    requests += list.length;
    input += sIn;
    saving += sSave;
    cold += coldRows.length;
  }
  const share = requests ? ((cold / requests) * 100).toFixed(1) : '0.0';
  const pct = input ? ((saving / input) * 100).toFixed(2) : '0.00';
  out.push(
    `verdict: ${sessions.size} sessions, ${requests} requests, ${share}% cold, cold-only clearing would save ${saving} of ${input} input tokens (${pct}%)`,
  );
  return out;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = process.argv[2] ?? DEFAULT_METRICS;
  if (!existsSync(path)) {
    console.log(`verdict: no metrics at ${path}`);
  } else {
    console.log(report(parseMetrics(readFileSync(path, 'utf8'))).join('\n'));
  }
}
