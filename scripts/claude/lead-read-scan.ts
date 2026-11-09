import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decide, maxBytes } from './lead-file-read.ts';

// Measures what the lead's read-family Bash commands returned, grouped by command form,
// and which forms the lead-file-read hook allows today.
// Usage: node scripts/claude/lead-read-scan.ts <unix-cutoff> <transcript-dir>
const readers =
  /^(?:\w+=\S*\s+)*(?:cat|sed|grep|egrep|rg|head|tail|find|ls|wc|awk|nl|less)\b/u;
const scripting = /^(?:python3?|node)\b/u;

export function form(command: string): string {
  const trimmed = command.trim();
  if (/<<-?\s*['"]?\w+/u.test(trimmed))
    return scripting.test(trimmed) ? 'heredoc script' : 'heredoc';
  if (scripting.test(trimmed)) return 'script';
  const bare = trimmed.replace(/2>&1|2>\/dev\/null|&>\/dev\/null/gu, '');
  if (/[<>]/u.test(bare)) return 'redirected';
  const lists = bare.split(/&&|\|\||;|\n/u).filter((part) => part.trim());
  if (lists.length > 1) {
    return /^cd\s+\S+$/u.test(lists[0]?.trim() ?? '') && lists.length === 2
      ? 'cd-prefixed'
      : 'compound';
  }
  return /\|/u.test(bare) ? 'piped' : 'plain';
}

export function isReadFamily(command: string): boolean {
  return command
    .split(/&&|\|\||;|\n|\|/u)
    .some((part) => readers.test(part.trim()));
}

function size(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content);
  if (Array.isArray(content))
    return content.reduce(
      (sum: number, item: { text?: string }) =>
        sum + Buffer.byteLength(item?.text ?? ''),
      0,
    );
  return 0;
}

type Row = {
  bytes: number;
  n: number;
  allowed: number;
  allowedBytes: number;
  allowedOver: number;
};

type Block = {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  input?: { command?: unknown };
  content?: unknown;
};
type Entry = {
  isSidechain?: boolean;
  timestamp?: string;
  cwd?: string;
  message?: { content?: Block[] };
};

function main() {
  const cutoff = Number(process.argv[2]) * 1000;
  const dir = process.argv[3] ?? '';
  const rows = new Map<string, Row>();
  let total = 0;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const file = join(dir, name);
    if (statSync(file).mtimeMs < cutoff) continue;
    const calls = new Map<string, { command: string; cwd: string }>();
    let started = Number.POSITIVE_INFINITY;
    const results = new Map<string, number>();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      let entry: Entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.isSidechain) continue;
      if (entry.timestamp)
        started = Math.min(started, Date.parse(entry.timestamp));
      for (const block of entry.message?.content ?? []) {
        if (block?.type === 'tool_use' && block.name === 'Bash')
          calls.set(String(block.id), {
            command: String(block.input?.command ?? ''),
            cwd: String(entry.cwd ?? process.cwd()),
          });
        if (block?.type === 'tool_result')
          results.set(String(block.tool_use_id), size(block.content));
      }
    }
    if (started < cutoff) continue;
    for (const [id, bytes] of results) {
      const call = calls.get(id);
      if (!call) continue;
      total += bytes;
      if (!isReadFamily(call.command)) continue;
      const key = form(call.command);
      const row = rows.get(key) ?? {
        bytes: 0,
        n: 0,
        allowed: 0,
        allowedBytes: 0,
        allowedOver: 0,
      };
      row.bytes += bytes;
      row.n += 1;
      const refused = decide({
        cwd: call.cwd,
        tool_name: 'Bash',
        tool_input: { command: call.command },
      });
      if (!refused) {
        row.allowed += 1;
        row.allowedBytes += bytes;
        if (bytes > maxBytes) row.allowedOver += 1;
      }
      rows.set(key, row);
    }
  }
  console.log(`lead Bash result bytes: ${total}`);
  console.log(
    'form | bytes | n | hook allows (n) | hook allows (bytes) | allowed results over budget',
  );
  for (const [key, row] of [...rows].sort((a, b) => b[1].bytes - a[1].bytes))
    console.log(
      `${key} | ${row.bytes} | ${row.n} | ${row.allowed} | ${row.allowedBytes} | ${row.allowedOver}`,
    );
}
if (process.argv[1]?.endsWith('lead-read-scan.ts')) main();
