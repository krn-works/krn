// Claude Code specifics: the binary, its headless run arguments, the hook payload codec, the usage normaliser and where its instructions and state live. Callers name these, never the literals.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The agent name and binary of Claude Code. */
export const claudeAgent = 'claude';

/** True when the environment carries the markers Claude Code exports to its child processes. */
export function isClaudeSession(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDECODE === '1' || Boolean(env.CLAUDE_CODE_SESSION_ID);
}

/** Flags of a relayed interactive lead: never stop on permission prompts; model and effort when given. */
export function relayFlags(options: {
  model?: string | undefined;
  effort?: string | undefined;
}): string[] {
  return [
    '--permission-mode',
    'bypassPermissions',
    ...(options.model ? ['--model', options.model] : []),
    ...(options.effort ? ['--effort', options.effort] : []),
  ];
}

/** The per-project and per-user directory Claude Code reads settings, skills and memory from. */
export const claudeDir = '.claude';

/** The instruction file Claude Code loads in every session. */
export const instructionFile = 'CLAUDE.md';

/** The repository paths that steer an agent harness: a worker never edits them. */
export const harnessPaths = [
  '.agents/',
  `${claudeDir}/`,
  'AGENTS.md',
  instructionFile,
] as const;

/** The binary a lane runs: `KRN_LANE_CLAUDE` names a stand-in for tests. */
export function laneBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.KRN_LANE_CLAUDE ?? claudeAgent;
}

/** A path inside a project's Claude Code directory, e.g. `projectPath(root, 'settings.json')`. */
export function projectPath(root: string, ...parts: string[]): string {
  return join(root, claudeDir, ...parts);
}

/** The project-relative path of a file in the Claude Code directory, for messages and reports. */
export function projectRelative(...parts: string[]): string {
  return [claudeDir, ...parts].join('/');
}

/** The user configuration directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function configHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return env.CLAUDE_CONFIG_DIR ?? join(home, claudeDir);
}

/** The user directory under a given home, ignoring `CLAUDE_CONFIG_DIR` (installers that take an explicit home). */
export function userDir(home: string): string {
  return join(home, claudeDir);
}

/** The user state file (`~/.claude.json`, or `.claude.json` inside `CLAUDE_CONFIG_DIR`). */
export function userStateFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR
    ? join(env.CLAUDE_CONFIG_DIR, `${claudeDir}.json`)
    : join(homedir(), `${claudeDir}.json`);
}

/** The arguments of one headless lane session: brief in, one JSON result out. */
export interface HeadlessRun {
  brief: string;
  settings: string;
  model: string;
  fallbackModel: string;
  budgetUsd: number;
  /** The advisor model for this session only (`--advisor`); absent leaves the advisor off. */
  advisor?: string;
}

export function headlessArgs(run: HeadlessRun): string[] {
  return [
    '-p',
    run.brief,
    '--output-format',
    'json',
    '--settings',
    run.settings,
    '--permission-mode',
    'acceptEdits',
    '--model',
    run.model,
    '--fallback-model',
    run.fallbackModel,
    '--max-budget-usd',
    String(run.budgetUsd),
    '--setting-sources',
    'project',
    ...(run.advisor === undefined ? [] : ['--advisor', run.advisor]),
  ];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected object');
  return value as Record<string, unknown>;
}

/** The project directory Claude Code hands to a hook, else the working directory. */
export function hookProjectDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

let providedStdin: string | undefined;

/** Hands the hook payload the dispatcher already read to the route modules that follow, which would find a drained stdin. */
export function provideHookStdin(raw: string | undefined): void {
  providedStdin = raw;
}

/** The hook payload: the dispatcher's, else this process's stdin. */
export function hookStdin(): string {
  return providedStdin ?? readFileSync(0, 'utf8');
}

/** Decodes a hook payload; throws when it is not one of `eventNames` or lacks the project. */
export function hookInput(
  eventNames: string[],
  raw: string = hookStdin(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const input = record(JSON.parse(raw));
  const { session_id, transcript_path, hook_event_name } = input;
  const project = env.CLAUDE_PROJECT_DIR;
  if (
    typeof session_id !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/u.test(session_id) ||
    typeof transcript_path !== 'string' ||
    !transcript_path ||
    typeof hook_event_name !== 'string' ||
    !eventNames.includes(hook_event_name) ||
    !project
  )
    throw new Error('Invalid hook input');
  return {
    sessionId: session_id,
    transcriptPath: transcript_path,
    event: hook_event_name,
    project,
    source: input.source,
  };
}

/** Encodes context a hook adds to the session. */
export function emitContext(event: string, text: string) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: text },
    }),
  );
}

/** Token usage of one assistant message, with cache writes split by lifetime. */
export type Usage = {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
};

const looseRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

/** Normalises a transcript `message.usage` object; a missing or malformed counter counts as 0. */
export function usageOf(raw: unknown): Usage {
  const u = looseRecord(raw);
  const split = looseRecord(u.cache_creation);
  const total = count(u.cache_creation_input_tokens);
  const has5m = typeof split.ephemeral_5m_input_tokens === 'number';
  const has1h = typeof split.ephemeral_1h_input_tokens === 'number';
  // Without the split every cache write is priced as a 5-minute write.
  const w1h = has1h ? count(split.ephemeral_1h_input_tokens) : 0;
  const w5m =
    has5m || has1h
      ? count(split.ephemeral_5m_input_tokens) +
        Math.max(0, total - count(split.ephemeral_5m_input_tokens) - w1h)
      : total;
  return {
    input: count(u.input_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
    output: count(u.output_tokens),
  };
}

/** The prompt-side counters of a usage object (input, cache read, cache creation), unchecked. */
export function promptCounters(raw: Record<string, unknown>): unknown[] {
  return [
    raw.input_tokens,
    raw.cache_read_input_tokens,
    raw.cache_creation_input_tokens,
  ];
}

/** The ledger's token totals keyed as the transcript names them. */
export const usageKeys = {
  input: 'input_tokens',
  cache_read: 'cache_read_input_tokens',
  cache_creation: 'cache_creation_input_tokens',
  output: 'output_tokens',
} as const;
