// Contamination scan of screened sessions (ADR 0021): a session is contaminated when a tool call that can reach the
// upstream repository or the web returned content. The scan reads each call's result, so a `gh` refused for want of a
// login or a remote is not contamination, and a repository path inside a Go import or a test name is not a network
// call at all. Usage: node evals/replay/contamination.ts <rows.jsonl> <scratch>; prints one line per flagged row.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRows } from './screen.ts';

export interface Hit {
  /** `gh`, `git` (remote operations), `http` (curl or wget) or the web tool's name. */
  kind: string;
  /** The tool call input, cut to 200 characters. */
  call: string;
  /** True when the result shows the call reached nothing. */
  failed: boolean;
}

/** Each kind of access: how a command invokes it and the result lines that show one invocation reached nothing. */
const KINDS = [
  {
    kind: 'gh',
    call: /(?:^|[\s;&|(`'"])gh\s+(?:pr|issue|api|repo|search|release|browse|run|gist)\b/g,
    failed:
      /^(?:To get started with GitHub CLI|To use GitHub CLI in a GitHub Actions workflow|no git remotes found|GraphQL: Could not resolve|gh: .*\(HTTP 40[134]\)|HTTP 40[134]:|.*\bgh: (?:command )?not found)/gm,
  },
  {
    kind: 'git',
    call: /\bgit\s+(?:clone|fetch|pull|ls-remote|remote\s+add)\b/g,
    failed: /^(?:fatal: |.*\bgit: (?:command )?not found)/gm,
  },
  {
    kind: 'http',
    call: /(?:^|[\s;&|(`'"])(?:curl|wget)\s/g,
    failed:
      /^(?:curl: \(\d+\)|wget: |.*ERROR 40[134]|.*\b(?:curl|wget): (?:command )?not found)/gm,
  },
] as const;

/** A URL off this host: a session's curl of its own test server is local. */
const REMOTE_URL =
  /\b(?:https?:\/\/)?(?!localhost\b|127\.|0\.0\.0\.0|\[::1\])[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i;
/**
 * A GitHub URL with a scheme next to a fetch call reaches the upstream whatever runs it (python -c, node -e); an import
 * path has no scheme, and a link written into a changelog has no fetch.
 */
const FETCH_CALL =
  /\b(?:urlopen|urllib|requests\.(?:get|post)|httpx|fetch\(|https?\.get|axios|Invoke-WebRequest)/;
const GITHUB_URL =
  /https?:\/\/(?:api\.github\.com|github\.com|raw\.githubusercontent\.com|codeload\.github\.com)\//i;
/** A nested shell or eval runs its quoted argument, so its quotes stay. */
const NESTED = /\b(?:sh|bash|zsh)\s+-l?c\b|\beval\b/;

/** The command without quoted text that runs nothing: `grep "gh run"` names gh, `"$(gh api …)"` runs it. */
const executable = (cmd: string): string =>
  NESTED.test(cmd)
    ? cmd
    : cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\$`]|\\.)*"/g, '""');

/** A web tool result that is a refusal, not a page. */
const WEB_REFUSED =
  /tool is not available|No such tool available|has been denied|permission to use \w+ has been denied/i;

/** Each kind of upstream or web access a tool call can make, with its invocation count; empty for a local call. */
export function accessesOf(
  name: string,
  input: unknown,
): { kind: string; calls: number }[] {
  if (name === 'WebFetch' || name === 'WebSearch')
    return [{ kind: name, calls: 1 }];
  if (name !== 'Bash') return [];
  const raw = String((input as { command?: unknown } | null)?.command ?? '');
  const cmd = executable(raw);
  const out: { kind: string; calls: number }[] = [];
  for (const k of KINDS) {
    const calls = cmd.match(k.call)?.length ?? 0;
    if (calls === 0) continue;
    if (k.kind === 'http' && !REMOTE_URL.test(raw)) continue;
    out.push({ kind: k.kind, calls });
  }
  if (
    GITHUB_URL.test(raw) &&
    FETCH_CALL.test(raw) &&
    !out.some((a) => a.kind === 'http')
  )
    out.push({ kind: 'http', calls: 1 });
  return out;
}

/** The first kind of access a tool call can make, or undefined for a local call. */
export const accessOf = (name: string, input: unknown): string | undefined =>
  accessesOf(name, input)[0]?.kind;

/**
 * Whether every invocation of `kind` in a result reached nothing. An empty result returned nothing; otherwise a kind is
 * cleared only when its own failure lines number at least its invocations, so one refused gh beside a curl that
 * returned the fix, or a second gh that worked, still counts.
 */
function failedAll(kind: string, calls: number, text: string): boolean {
  if (text.trim() === '') return true;
  if (kind === 'WebFetch' || kind === 'WebSearch')
    return WEB_REFUSED.test(text);
  const k = KINDS.find((x) => x.kind === kind);
  return k !== undefined && (text.match(k.failed)?.length ?? 0) >= calls;
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  text?: string;
}

const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .map((b: Block) => (typeof b?.text === 'string' ? b.text : ''))
          .join('\n')
      : '';

/** Every upstream or web access in one session transcript (Claude Code JSONL) with whether its result came back empty. */
export function scanTranscript(jsonl: string): Hit[] {
  const uses: Block[] = [];
  const results = new Map<string, { text: string; error: boolean }>();
  for (const line of jsonl.split('\n')) {
    if (!line.includes('tool_')) continue;
    let content: unknown;
    try {
      content = (JSON.parse(line) as { message?: { content?: unknown } })
        .message?.content;
    } catch {
      // A torn last line of a killed session holds no complete call.
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[])
      if (b.type === 'tool_use') uses.push(b);
      else if (b.type === 'tool_result' && b.tool_use_id)
        results.set(b.tool_use_id, {
          text: textOf(b.content),
          error: b.is_error === true,
        });
  }
  const hits: Hit[] = [];
  for (const u of uses)
    for (const { kind, calls } of accessesOf(u.name ?? '', u.input)) {
      const r = results.get(u.id ?? '');
      // No result: the session died mid-call, so nothing came back into the session. A web tool error is a refusal;
      // a Bash exit code says nothing about what an earlier command in it printed.
      const web = kind === 'WebFetch' || kind === 'WebSearch';
      const failed = !r || (web && r.error) || failedAll(kind, calls, r.text);
      hits.push({
        kind,
        call: JSON.stringify(u.input ?? {}).slice(0, 200),
        failed,
      });
    }
  return hits;
}

/** True when some access returned content. */
export const contaminated = (hits: Hit[]): boolean =>
  hits.some((h) => !h.failed);

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Transcripts under a screen scratch directory, by session id: the session's own `<id>.jsonl` and every subagent
 * transcript under its `<id>/` directory, since a subagent's tool calls are the session's too.
 */
export function transcripts(scratch: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (id: string, f: string) =>
    found.set(id, [...(found.get(id) ?? []), f]);
  const walk = (d: string, owner: string | undefined) => {
    for (const e of readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory())
        walk(join(d, e.name), SESSION_ID.test(e.name) ? e.name : owner);
      else if (e.name.endsWith('.jsonl'))
        add(owner ?? e.name.slice(0, -6), join(d, e.name));
  };
  const root = join(scratch, 'claude-config', 'projects');
  if (existsSync(root)) walk(root, undefined);
  return found;
}

export interface RowScan {
  unit: string;
  rep: number;
  pass: boolean | null;
  /** False when no transcript of the row's session was found. */
  transcript: boolean;
  hits: Hit[];
}

/** Scans every row of a screen: the session ids come from the row's session log `<unit>-<rep>.log`. */
export function scanRows(rowsFile: string, scratch: string): RowScan[] {
  const all = transcripts(scratch);
  return readRows(rowsFile).map((r) => {
    const log = join(scratch, `${r.unit}-${r.rep}.log`);
    const ids = existsSync(log)
      ? [
          ...readFileSync(log, 'utf8').matchAll(
            /"session_id":"([0-9a-f-]{36})"/g,
          ),
        ].map((m) => m[1] as string)
      : [];
    const files = ids.flatMap((id) => all.get(id) ?? []);
    return {
      unit: r.unit,
      rep: r.rep,
      pass: r.pass,
      transcript: files.length > 0,
      hits: files.flatMap((f) => scanTranscript(readFileSync(f, 'utf8'))),
    };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [rowsFile, scratch] = process.argv.slice(2);
  if (!rowsFile || !scratch) {
    console.error(
      'usage: node evals/replay/contamination.ts <rows.jsonl> <scratch>',
    );
    process.exit(64);
  }
  const rows = scanRows(rowsFile, scratch);
  const flagged = rows.filter((r) => contaminated(r.hits));
  for (const r of flagged)
    console.log(
      `${r.unit}/${r.rep} pass=${r.pass} ${r.hits
        .filter((h) => !h.failed)
        .map((h) => `${h.kind} ${h.call.slice(0, 120)}`)
        .join(' | ')}`,
    );
  console.log(
    `contamination: ${flagged.length} flagged of ${rows.length} rows (passes ${flagged.filter((r) => r.pass === true).length}); transcripts missing ${rows.filter((r) => !r.transcript).length}`,
  );
}
