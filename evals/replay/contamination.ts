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

const GH =
  /(?:^|[\s;&|(`])gh\s+(?:pr|issue|api|repo|search|release|browse|run|gist)\b/;
const GIT = /\bgit\s+(?:clone|fetch|pull|ls-remote|remote\s+add)\b/;
const HTTP = /(?:^|[\s;&|(`])(?:curl|wget)\s/;
/** A URL off this host: a session's curl of its own test server is local. */
const REMOTE_URL =
  /\b(?:https?:\/\/)?(?!localhost\b|127\.|0\.0\.0\.0|\[::1\])[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i;

/** The command without quoted text that runs nothing: `grep "gh run"` names gh, `"$(gh api …)"` runs it. */
const executable = (cmd: string): string =>
  cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\$`]|\\.)*"/g, '""');

/** Result text of a call that reached nothing: a refused login, no remote, an unreachable host, a missing page. */
const FAILED =
  /no git remotes found|gh auth login|GH_TOKEN environment variable|HTTP 40[134]\b|Could not resolve (?:host|to a Repository)|could not read Username|Repository not found|Authentication failed|not a git repository|command not found|tool is not available|No such tool available|has been denied|permission to use \w+ has been denied/i;

/** The kind of upstream or web access a tool call can make, or undefined for a local call. */
export function accessOf(name: string, input: unknown): string | undefined {
  if (name === 'WebFetch' || name === 'WebSearch') return name;
  if (name !== 'Bash') return undefined;
  const raw = String((input as { command?: unknown } | null)?.command ?? '');
  const cmd = executable(raw);
  if (GH.test(cmd)) return 'gh';
  if (GIT.test(cmd)) return 'git';
  if (HTTP.test(cmd) && REMOTE_URL.test(raw)) return 'http';
  return undefined;
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
  for (const u of uses) {
    const kind = accessOf(u.name ?? '', u.input);
    if (!kind) continue;
    const r = results.get(u.id ?? '');
    // No result: the session died mid-call, so nothing came back into the session.
    const failed = !r || r.error || r.text.trim() === '' || FAILED.test(r.text);
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

/** Session transcripts under a screen scratch directory, by session id. */
export function transcripts(scratch: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.jsonl'))
        found.set(e.name.slice(0, -6), join(d, e.name));
  };
  const root = join(scratch, 'claude-config', 'projects');
  if (existsSync(root)) walk(root);
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
    const files = ids
      .map((id) => all.get(id))
      .filter((f): f is string => f !== undefined);
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
