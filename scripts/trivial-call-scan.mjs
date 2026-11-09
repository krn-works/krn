#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
// Reports lead turns whose only tool call is a trivial cd/ls/git/gh/krn read,
// grouped by the family of the previous Bash command, per merged PR.
// Usage: node scripts/trivial-call-scan.mjs [transcript-dir] [since-iso-date]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir =
  process.argv[2] ??
  `${process.env.HOME}/.claude/projects/-mnt-storage-coding-krn-active-krn`;
const since = process.argv[3] ?? '2026-11-08';
const TRIVIAL = /^(cd|ls|pwd|echo|date|printf|git|gh|krn|bin\/krn)$/;

export const family = (command) => {
  const words = command
    .trim()
    .replace(/^(cd\s+\S+\s*(&&|;)\s*)+/, '')
    .split(/[\s;&|]+/);
  const head = words[0] ?? '';
  return ['git', 'gh', 'krn', 'bin/krn', 'npm'].includes(head)
    ? `${head.replace('bin/', '')} ${words[1] ?? ''}`.trim()
    : head;
};

const after = new Map();
const own = new Map();
let single = 0;
const merges = execFileSync(
  'git',
  ['log', 'origin/main', `--since=${since}`, '--format=%s'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((subject) => /\(#\d+\)$/.test(subject)).length;
for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
  let prev = '(start)';
  const seen = new Set();
  for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== 'assistant' || (d.timestamp ?? '') < since) continue;
    const id = d.message?.id ?? d.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    const uses = (d.message.content ?? []).filter((b) => b.type === 'tool_use');
    if (uses.length !== 1 || uses[0].name !== 'Bash') {
      if (uses.length)
        prev =
          uses[uses.length - 1].name === 'Bash'
            ? family(uses[uses.length - 1].input.command ?? '')
            : uses[uses.length - 1].name;
      continue;
    }
    const cmd = uses[0].input.command ?? '';
    const fam = family(cmd);
    if (TRIVIAL.test(fam.split(' ')[0]) && cmd.split('\n').length === 1) {
      single += 1;
      const key = `${prev} -> ${fam}`;
      after.set(key, (after.get(key) ?? 0) + 1);
      own.set(fam, (own.get(fam) ?? 0) + 1);
    }
    prev = fam;
  }
}
console.log(
  `single-trivial-call turns: ${single}; merged PRs: ${merges}; per PR: ${(single / Math.max(merges, 1)).toFixed(2)}`,
);
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
console.log('-- by family');
for (const [k, v] of top(own, 12)) console.log(String(v).padStart(5), k);
console.log('-- by previous command -> trivial call');
for (const [k, v] of top(after, Number(process.env.TOP ?? 20)))
  console.log(String(v).padStart(5), k);
