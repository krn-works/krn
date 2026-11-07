import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// The operator inbox records every operator prompt under .krn/operator so a directive cannot
// vanish between sessions. Imports stay minimal: the capture hook runs on every prompt.

export type InboxEntry = {
  hash: string;
  session: string;
  time: string;
  text: string;
};
export type Disposition = {
  hash: string;
  kind: 'task' | 'memory' | 'answered';
  ref: string;
  time: string;
};

export const maxText = 4000;

const secretPatterns = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [^-]*-----|$)/giu,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/gu,
  /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{16,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{16,}/gu,
  /\bnpm_[A-Za-z0-9]{36,}/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bAIza[A-Za-z0-9_-]{35}/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/gu,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/giu,
];
const assignment =
  /\b((?:[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|credential)[A-Za-z0-9_-]*)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/giu;

export function redact(text: string): string {
  let out = text;
  for (const pattern of secretPatterns)
    out = out.replace(pattern, '[REDACTED]');
  return out.replace(assignment, '$1[REDACTED]');
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// Worktrees share one inbox: resolve the main checkout from the .git file without spawning git.
export function inboxRoot(root: string): string {
  const base = resolve(root);
  try {
    if (!statSync(join(base, '.git')).isFile()) return base;
    const match = /^gitdir:\s*(.+)$/mu.exec(
      readFileSync(join(base, '.git'), 'utf8'),
    );
    const gitdir = resolve(base, match?.[1]?.trim() ?? '');
    const marker = `${join('.git', 'worktrees')}`;
    const index = gitdir.lastIndexOf(marker);
    return index > 0 ? gitdir.slice(0, index - 1) : dirname(dirname(gitdir));
  } catch {
    return base;
  }
}

const directory = (root: string) => join(inboxRoot(root), '.krn/operator');
export const inboxFile = (root: string) => join(directory(root), 'inbox.jsonl');
const dispositionFile = (root: string) =>
  join(directory(root), 'dispositions.jsonl');
const boundaryFile = (root: string) => join(directory(root), 'handoff-at');

function lines<T>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* A torn last line must not hide the rest. */
    }
  }
  return out;
}

// Claude Code submits background-agent notifications and other harness wrappers
// through UserPromptSubmit; they are not operator words.
const harnessWrapper =
  /^<(task-notification|system-reminder|local-command-[a-z]+|bash-(input|stdout|stderr)|command-(name|message|args))>/u;

export const isHarnessText = (text: string): boolean =>
  harnessWrapper.test(text.trimStart());

export function capture(root: string, session: string, prompt: string): void {
  if (isHarnessText(prompt)) return;
  const text = redact(prompt.trim()).slice(0, maxText);
  if (!text) return;
  mkdirSync(directory(root), { recursive: true });
  const entry: InboxEntry = {
    hash: hashText(text),
    session,
    time: new Date().toISOString(),
    text,
  };
  appendFileSync(inboxFile(root), `${JSON.stringify(entry)}\n`);
}

export function dispose(
  root: string,
  hash: string,
  kind: Disposition['kind'],
  ref: string,
): void {
  mkdirSync(directory(root), { recursive: true });
  const entry: Disposition = {
    hash,
    kind,
    ref,
    time: new Date().toISOString(),
  };
  appendFileSync(dispositionFile(root), `${JSON.stringify(entry)}\n`);
}

export function markHandoff(root: string): void {
  try {
    if (lines(inboxFile(root)).length === 0) return;
    mkdirSync(directory(root), { recursive: true });
    appendFileSync(boundaryFile(root), `${new Date().toISOString()}\n`);
  } catch {
    /* The boundary is advisory; a failed write keeps entries open, never hides them. */
  }
}

function lastHandoff(root: string): string {
  try {
    return (
      readFileSync(boundaryFile(root), 'utf8').trim().split('\n').pop() ?? ''
    );
  } catch {
    return '';
  }
}

// Short acknowledgements, questions and slash commands need no durable record.
export function looksLikeDirective(text: string): boolean {
  const body = text.trim();
  if (body.length < 25 || body.startsWith('/') || isHarnessText(body))
    return false;
  if (body.endsWith('?') && !/\n/u.test(body) && body.length < 300)
    return false;
  return true;
}

export function allEntries(root: string): InboxEntry[] {
  return lines<InboxEntry>(inboxFile(root)).filter(
    (entry) => typeof entry.hash === 'string' && typeof entry.text === 'string',
  );
}

export function disposed(root: string): Set<string> {
  return new Set(lines<Disposition>(dispositionFile(root)).map((d) => d.hash));
}

// Undisposed directive-like entries since the last handoff.
export function openEntries(root: string): InboxEntry[] {
  const since = lastHandoff(root);
  const done = disposed(root);
  const seen = new Set<string>();
  return allEntries(root).filter((entry) => {
    if (entry.time <= since || done.has(entry.hash) || seen.has(entry.hash))
      return false;
    seen.add(entry.hash);
    return looksLikeDirective(entry.text);
  });
}
