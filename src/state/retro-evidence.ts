// The evidence `krn state retro --sessions N` ranks: typed items read from
// Claude session transcripts (tool errors, refusals, operator corrections) and
// from `krn-review:` pull request comments (findings). Read-only; every item
// carries a pointer (`<transcript>:<line>` or `PR#<n>:<file:line>`).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export type EvidenceKind =
  | 'tool-error'
  | 'refusal'
  | 'operator-correction'
  | 'review-finding';

export interface EvidenceItem {
  kind: EvidenceKind;
  /** The module (review findings) or the normalized first line (transcripts) the item clusters under. */
  subject: string;
  text: string;
  pointer: string;
  /** Review round (the comment's order within its PR); 0 for transcripts. */
  round: number;
}

const REFUSAL = /^(<tool_use_error>)?(Blocked:|Refused:)|hook error/;
const CORRECTION =
  /(^|\W)(nie |no,|stop\b|don't|do not|wrong|zamiast|przecież|przeciez|dlaczego|why did)/i;

/** Collapses digits, hashes and quoted paths so equal causes cluster. */
export function normalizeLine(text: string): string {
  const first = (text.trim().split('\n')[0] ?? '')
    .replace(/<\/?tool_use_error>/g, '')
    .split(/ followed by|\. /)[0] as string;
  return first
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\d+/g, '<n>')
    .slice(0, 100);
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && 'text' in part
        ? String((part as { text: unknown }).text)
        : '',
    )
    .join('\n');
}

/** Reads one Claude transcript (JSONL); malformed lines are skipped. */
export function readTranscript(path: string, name = basename(path)) {
  const items: EvidenceItem[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  let prompts = 0;
  lines.forEach((raw, index) => {
    if (!raw.trim()) return;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(raw);
    } catch {
      return;
    }
    if (entry.type !== 'user') return;
    const pointer = `${name}:${index + 1}`;
    const content = entry.message?.content;
    if (typeof content === 'string') {
      prompts += 1;
      const real = !content.startsWith('<') && !content.startsWith('[');
      if (real && prompts > 1 && CORRECTION.test(content))
        items.push({
          kind: 'operator-correction',
          subject: normalizeLine(content),
          text: content.slice(0, 200),
          pointer,
          round: 0,
        });
      return;
    }
    if (!Array.isArray(content)) return;
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type !== 'tool_result') continue;
      const text = blockText(part.content);
      const refusal = REFUSAL.test(text);
      if (part.is_error !== true && !refusal) continue;
      items.push({
        kind: refusal ? 'refusal' : 'tool-error',
        subject: normalizeLine(text),
        text: text.slice(0, 200),
        pointer,
        round: 0,
      });
    }
  });
  return items;
}

/** Parses the findings of one `krn-review:` comment body. */
export function parseReviewComment(
  body: string,
  pr: number,
  round: number,
): EvidenceItem[] {
  if (!body.startsWith('krn-review:')) return [];
  const items: EvidenceItem[] = [];
  for (const match of body.matchAll(
    /^- \*\*(?:not )?reproduced\*\* (.+?) \(([^)]+)\)$/gm,
  )) {
    const where = (match[2] as string).split(',')[0]?.trim() ?? '';
    items.push({
      kind: 'review-finding',
      subject: where.replace(/:\d+$/, ''),
      text: match[1] as string,
      pointer: `PR#${pr}:${where}`,
      round,
    });
  }
  return items;
}

/** The newest `limit` transcripts of this repository (and its worktrees) under a Claude projects directory. */
export function recentTranscripts(
  root: string,
  limit: number,
  projects: string,
): string[] {
  const slug = root.replace(/[/.]/g, '-');
  let dirs: string[];
  try {
    dirs = readdirSync(projects).filter((d) => d.startsWith(slug));
  } catch {
    return [];
  }
  return dirs
    .flatMap((dir) =>
      readdirSync(join(projects, dir))
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => join(projects, dir, file)),
    )
    .map((path) => ({ path, at: statSync(path).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((entry) => entry.path);
}
