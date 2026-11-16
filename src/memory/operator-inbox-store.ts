import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cutText } from './cut-text.ts';

// The operator inbox records every operator prompt under .krn/operator so a directive cannot
// vanish between sessions. Imports stay minimal: the capture hook runs on every prompt.

export type InboxEntry = {
  hash: string;
  session: string;
  time: string;
  text: string;
  // Set by a launcher (SESSION_CLASS_VARIABLE): the prompt came from automation.
  source?: SessionClass;
  // Set from the transcript row of the prompt: the harness or an agent wrote it, not the operator.
  origin?: string;
};
export type Disposition = {
  hash: string;
  kind: 'task' | 'memory' | 'answered';
  ref: string;
  time: string;
};

export const maxText = 4000;

// Every launcher that starts a session sets this variable to the session's class;
// its presence means automation started the session, not the operator.
export const SESSION_CLASS_VARIABLE = 'KRN_SESSION_CLASS';
export const SESSION_CLASSES = ['delivery', 'non-delivery', 'lane'] as const;
export type SessionClass = (typeof SESSION_CLASSES)[number];
export const isSessionClass = (value: unknown): value is SessionClass =>
  SESSION_CLASSES.some((name) => name === value);
export const launcherClass = (
  env: NodeJS.ProcessEnv,
): SessionClass | undefined => {
  const value = env[SESSION_CLASS_VARIABLE];
  return isSessionClass(value) ? value : undefined;
};

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
const sessionFile = (root: string) => join(directory(root), 'sessions.jsonl');
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

// Plain-text harness prompts seen in real transcripts: the compaction summary and the interrupt marker.
const harnessSentence =
  /^(This session is being continued from a previous conversation|\[Request interrupted by user)/u;

// Harness blocks injected into the middle of a prompt: reminders, hook context, notifications.
const harnessBlock =
  /<(task-notification|system-reminder|local-command-[a-z]+|bash-(?:input|stdout|stderr)|command-(?:name|message|args)|[a-z-]*additional-context)>[\s\S]*?(?:<\/\1>|$)/gu;

// The prompt without its harness blocks; what remains is the operator's own words.
export const stripHarnessBlocks = (text: string): string =>
  text.replace(harnessBlock, '').trim();

export const isHarnessText = (text: string): boolean =>
  harnessWrapper.test(text.trimStart()) ||
  harnessSentence.test(text.trimStart());

// Headless `claude -p` runs carry no payload marker; Claude Code sets these in the hook
// environment (interactive: cli / 1, headless: sdk-cli / 0). Interactive sessions always
// have a UUID session id, so hand-fed benchmark payloads ("bench") are skipped too.
const sessionId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const isAutomatedSession = (
  session: string,
  env: NodeJS.ProcessEnv,
): boolean =>
  env.CLAUDE_CODE_SESSION_ATTENDED === '0' ||
  (env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk') ||
  !sessionId.test(session);

// What the inbox stores for a prompt: redacted, trimmed, at most maxText.
export const inboxText = (prompt: string): string =>
  cutText(redact(prompt.trim()), maxText);

// A prompt flattened to one line of at most `length` UTF-16 units.
export const oneLine = (text: string, length: number): string =>
  cutText(text.replace(/\s+/gu, ' '), length);

// The origin kind Claude Code records on the transcript row of a prompt ("human",
// "task-notification", "auto-continuation"); a missing row or file means unknown.
export function promptOrigin(
  transcriptPath: unknown,
  promptId: unknown,
): string | undefined {
  if (typeof transcriptPath !== 'string' || typeof promptId !== 'string')
    return undefined;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, 1 << 20);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const rows = buffer.toString('utf8').split('\n').reverse();
      for (const row of rows) {
        if (!row.includes(promptId)) continue;
        const parsed = JSON.parse(row) as {
          promptId?: string;
          type?: string;
          origin?: { kind?: unknown };
        };
        if (parsed.type === 'user' && parsed.promptId === promptId)
          return typeof parsed.origin?.kind === 'string'
            ? parsed.origin.kind
            : undefined;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    /* an unreadable transcript leaves the origin unknown, never blocks the prompt */
  }
  return undefined;
}

export function capture(
  root: string,
  session: string,
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
  origin?: string,
): void {
  if (isHarnessText(prompt) || isAutomatedSession(session, env)) return;
  const text = inboxText(stripHarnessBlocks(prompt));
  if (!text) return;
  mkdirSync(directory(root), { recursive: true });
  const source = launcherClass(env);
  const entry: InboxEntry = {
    hash: hashText(text),
    session,
    time: new Date().toISOString(),
    text,
    ...(source ? { source } : {}),
    ...(origin && origin !== 'human' ? { origin } : {}),
  };
  appendFileSync(inboxFile(root), `${JSON.stringify(entry)}\n`);
}

// The SessionStart hook records a launcher-marked session once, whatever the
// source (startup, resume, clear, compact) of the event.
export function recordSessionClass(
  root: string,
  session: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const sessionClass = launcherClass(env);
  if (!sessionClass) return;
  if (
    lines<{ session?: string }>(sessionFile(root)).some(
      (row) => row.session === session,
    )
  )
    return;
  mkdirSync(directory(root), { recursive: true });
  appendFileSync(
    sessionFile(root),
    `${JSON.stringify({ session, class: sessionClass, time: new Date().toISOString() })}\n`,
  );
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
    if (
      entry.source ||
      entry.origin ||
      entry.time <= since ||
      done.has(entry.hash) ||
      seen.has(entry.hash)
    )
      return false;
    seen.add(entry.hash);
    return looksLikeDirective(entry.text);
  });
}
