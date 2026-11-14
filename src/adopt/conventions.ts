// Seeds a repository's conventions file from its own instruction files, so the lane
// packet is not empty after adoption. Hand-kept records are never overwritten.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type BrainRecord, parseRecords } from '../brain/packet.ts';
import { BLOCK_END, BLOCK_START } from '../brain/standards.ts';
import { contractConventions } from '../repo/contract.ts';
import { mkdirSync, writeFileSync } from './journal.ts';

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
const BULLET = /^\s*[-*]\s+(.+)$/u;
const RULE_ID = /^\*\*([A-Za-z][A-Za-z0-9-]*)\*\*\s+(.+)$/u;
const MAX_TEXT = 320;

const slug = (text: string): string =>
  text
    .toLowerCase()
    .match(/[a-z0-9]+/gu)
    ?.slice(0, 5)
    .join('-') ?? 'rule';

/** One record per rule bullet of the instruction files: `**ID** text` keeps its id, any other bullet takes a slug of its first words. */
export function conventionRecords(root: string, today: string): BrainRecord[] {
  const seen = new Set<string>();
  const records: BrainRecord[] = [];
  for (const file of INSTRUCTION_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    // CLAUDE.md is usually a link to AGENTS.md: the same bullets count once. The generated
    // standards block is skipped: the lane brief lists those records from .agents/standards.json.
    let inStandards = false;
    for (const line of text.split('\n')) {
      if (line.trim() === BLOCK_START) inStandards = true;
      if (line.trim() === BLOCK_END) inStandards = false;
      if (inStandards) continue;
      const bullet = BULLET.exec(line)?.[1]?.trim();
      if (bullet === undefined || bullet.length < 20) continue;
      const rule = RULE_ID.exec(bullet);
      const body = (rule?.[2] ?? bullet)
        .replace(/\s+/gu, ' ')
        .slice(0, MAX_TEXT);
      const base = `r-${rule ? (rule[1] ?? '').toLowerCase() : slug(body)}`;
      let id = base;
      for (let n = 2; seen.has(id); n += 1) id = `${base}-${n}`;
      if (records.some((record) => record.text === body)) continue;
      seen.add(id);
      records.push({
        id,
        type: 'convention',
        text: body,
        recorded_at: today,
        valid_from: today,
        valid_to: null,
        source: file,
      });
    }
  }
  return parseRecords(records);
}

/** Writes the conventions file when it is absent and the instruction files hold rules; returns its relative path when written. */
export function seedConventions(root: string, today: string): string | null {
  const relative = contractConventions(root);
  const path = join(root, relative);
  if (existsSync(path)) return null;
  const records = conventionRecords(root, today);
  if (records.length === 0) return null;
  mkdirSync(dirname(path));
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
  return relative;
}
