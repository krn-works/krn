// One owner for the mechanical identifier index that SessionStart(compact) re-injects:
// paths, SHAs, PR numbers, task ids and error types seen before the newest compaction.
// Offline and deterministic; no model calls.
import { readFileSync } from 'node:fs';

export const identifierKinds = ['task', 'pr', 'sha', 'path', 'error'] as const;
export type IdentifierKind = (typeof identifierKinds)[number];
export type Identifier = { kind: IdentifierKind; value: string };

// One transcript entry reduced to the text an agent saw or wrote, in order.
export type Mention = {
  text: string;
  source: 'call' | 'prose' | 'prompt' | 'result';
};

const labels: Record<IdentifierKind, string> = {
  task: 'Tasks',
  pr: 'PRs',
  sha: 'SHAs',
  path: 'Paths',
  error: 'Errors',
};

export const perKindLimit = 40;
export const blockLimit = 1500;

// Project roots: the session directory first, then the main checkout.
export type Roots = string | string[];

// The first matching root prefix (and any worktree under it) is dropped so the same file
// matches across the main checkout and worktrees.
export function normalizePath(raw: string, roots: Roots): string {
  let path = raw.replace(/[),.:;'"`\]]+$/u, '');
  for (const root of [roots].flat()) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (path.startsWith(prefix)) {
      path = path.slice(prefix.length);
      break;
    }
  }
  path = path.replace(/^\.krn\/worktrees\/[^/]+\//u, '');
  return path.replace(/^\.\//u, '');
}

// Identifiers in one text, in order of appearance (duplicates kept).
export function extractIdentifiers(text: string, root: Roots): Identifier[] {
  const found: { at: number; id: Identifier }[] = [];
  const add = (
    kind: IdentifierKind,
    pattern: RegExp,
    map = (v: string) => v,
  ) => {
    for (const match of text.matchAll(pattern)) {
      const value = map(match[1] ?? match[0]);
      if (value) found.push({ at: match.index ?? 0, id: { kind, value } });
    }
  };
  add('task', /\b(t-[a-z0-9]{7})\b/gu);
  add(
    'pr',
    /(?:(?<![\w&])#|\/pull\/|\bpr (?:view|merge|checks|create|edit|close|update-branch|diff) )(\d{2,5})\b/gu,
  );
  // Hex runs with at least one digit and one letter; normalized to the 7-character short form.
  add('sha', /(?<![\w-])([0-9a-f]{7,40})(?![\w-])/gu, (value) =>
    /[a-f]/u.test(value) && /\d/u.test(value) ? value.slice(0, 7) : '',
  );
  add(
    'path',
    /(?<![\w@:/.-])((?:~?\/|\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]*\w\.[a-z]{1,5})(?![\w/])/gu,
    (value) => (/^https?:/u.test(value) ? '' : normalizePath(value, root)),
  );
  add('error', /\b((?:[A-Z][a-z]+)+Error|E[A-Z]{3,9}(?=[:\s,)]))\b/gu);
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.id);
}

function texts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return [record.text];
    if ('content' in record) return texts(record.content);
  }
  return [];
}

// Claude transcript entries reduced to mentions; tool calls, prose and tool results kept apart.
export function mentionsOf(entry: Record<string, unknown>): Mention[] {
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message || (entry.type !== 'user' && entry.type !== 'assistant'))
    return [];
  const content = message.content;
  // Injected user text (skills, reminders, earlier summaries) is a prompt, not agent prose.
  if (typeof content === 'string') return [{ text: content, source: 'prompt' }];
  if (!Array.isArray(content)) return [];
  const out: Mention[] = [];
  for (const part of content as Record<string, unknown>[]) {
    if (part.type === 'tool_use')
      out.push({ text: JSON.stringify(part.input ?? {}), source: 'call' });
    else if (part.type === 'tool_result')
      out.push({ text: texts(part.content).join('\n'), source: 'result' });
    else if (part.type === 'text' && typeof part.text === 'string')
      out.push({
        text: part.text,
        source: entry.type === 'assistant' ? 'prose' : 'prompt',
      });
  }
  return out;
}

export function parseTranscript(raw: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value))
        entries.push(value);
    } catch {
      /* A torn last line must not hide the rest. */
    }
  }
  return entries;
}

export function isBoundary(entry: Record<string, unknown>): boolean {
  return entry.type === 'system' && entry.subtype === 'compact_boundary';
}

// Weight of one mention by its source; tool-result noise such as directory listings counts
// less than what the agent called or wrote.
const sourceWeight: Record<Mention['source'], number> = {
  call: 1,
  prose: 1,
  prompt: 0.5,
  result: 0.25,
};

// Half-life of a mention, in mentions; recent and repeated identifiers rank first.
export const halfLife = 1000;

// Identifiers ranked by recency-decayed mention frequency, best first, at most
// `perKindLimit` of each kind.
export function rankIdentifiers(
  mentions: Mention[],
  root: Roots,
): Identifier[] {
  const found: { key: string; weight: number; at: number }[] = [];
  for (const mention of mentions)
    for (const id of extractIdentifiers(mention.text, root))
      found.push({
        key: `${id.kind}\u0000${id.value}`,
        weight: sourceWeight[mention.source],
        at: found.length,
      });
  const score = new Map<string, number>();
  for (const { key, weight, at } of found)
    score.set(
      key,
      (score.get(key) ?? 0) + weight * 0.5 ** ((found.length - at) / halfLife),
    );
  const ranked: Identifier[] = [];
  const counts = new Map<IdentifierKind, number>();
  for (const [key] of [...score.entries()].sort(([, a], [, b]) => b - a)) {
    const [kind, value] = key.split('\u0000') as [IdentifierKind, string];
    const count = counts.get(kind) ?? 0;
    if (count >= perKindLimit) continue;
    counts.set(kind, count + 1);
    ranked.push({ kind, value });
  }
  return ranked;
}

// Paths rendered as a brace-expansion tree keep the block dense:
// `scripts/{claude/{a.ts,b.ts},fast-check.ts}`. Order follows first appearance.
type Tree = Map<string, Tree>;

function renderTree(tree: Tree): string[] {
  return [...tree.entries()].map(([name, children]) => {
    if (children.size === 0) return name;
    const inner = renderTree(children);
    return inner.length === 1
      ? `${name}/${inner[0]}`
      : `${name}/{${inner.join(',')}}`;
  });
}

export function renderPaths(paths: string[]): string {
  const root: Tree = new Map();
  for (const path of paths) {
    let node = root;
    const parts = path.split('/');
    parts.forEach((part, index) => {
      // A leading slash keeps its empty first segment; a file is a leaf.
      const key = index === parts.length - 1 ? `\u0000${part}` : part;
      let next = node.get(key);
      if (!next) {
        next = new Map();
        node.set(key, next);
      }
      node = next;
    });
  }
  return renderTree(root).join(' ').replaceAll('\u0000', '');
}

function renderKind(kind: IdentifierKind, values: string[]): string {
  if (kind === 'path') return renderPaths(values);
  return values.map((value) => (kind === 'pr' ? `#${value}` : value)).join(' ');
}

// Takes identifiers best first while they fit the byte budget; one that does not fit is
// skipped so a shorter one later can still use the space.
export function buildIndex(
  ranked: Identifier[],
  limit = blockLimit,
): { text: string; chosen: Identifier[] } {
  const header = 'Identifiers before compaction (most used recently first):';
  const chosen: Identifier[] = [];
  const render = () =>
    [
      header,
      ...identifierKinds
        .map(
          (kind) =>
            [
              kind,
              chosen.filter((id) => id.kind === kind).map((id) => id.value),
            ] as const,
        )
        .filter(([, values]) => values.length > 0)
        .map(
          ([kind, values]) => `- ${labels[kind]}: ${renderKind(kind, values)}`,
        ),
    ].join('\n');
  for (const id of ranked) {
    chosen.push(id);
    if (Buffer.byteLength(render()) > limit) chosen.pop();
  }
  return { text: chosen.length > 0 ? render() : '', chosen };
}

export function renderIndex(ranked: Identifier[], limit = blockLimit): string {
  return buildIndex(ranked, limit).text;
}

// Mentions before the newest compaction boundary (all mentions when none exists).
export function mentionsBeforeLastBoundary(
  entries: Record<string, unknown>[],
): Mention[] {
  let end = entries.length;
  for (let index = entries.length - 1; index >= 0; index -= 1)
    if (isBoundary(entries[index] ?? {})) {
      end = index;
      break;
    }
  return entries.slice(0, end).flatMap(mentionsOf);
}

// The SessionStart(compact) block; an unreadable transcript yields no block.
export function compactIndex(transcriptPath: string, root: Roots): string {
  try {
    const entries = parseTranscript(readFileSync(transcriptPath, 'utf8'));
    return renderIndex(
      rankIdentifiers(mentionsBeforeLastBoundary(entries), root),
    );
  } catch {
    return '';
  }
}
