// Codex specifics for a headless replay session: the binary, its `codex exec` arguments, the private CODEX_HOME holding
// only the host's ChatGPT login, the egress hosts it needs and the reader of its result (realized model from the session
// rollout, all-attempt cost from its cumulative token count). Callers name these, never the literals.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The agent name and binary of Codex. */
export const codexAgent = 'codex';

/** The first-attempt lane model under trial. */
export const SOL_MODEL = 'gpt-6.2-sol';

/** The reasoning effort a replay session pins: the user config, which sets it, is not loaded. */
export const CODEX_EFFORT = 'medium';

/** True for a model a replay session runs on `codex exec` rather than `claude -p`. */
export const isCodexModel = (model: string): boolean => /^gpt-/u.test(model);

/** Hosts a Codex session reaches on top of the shared session hosts: the ChatGPT backend and its login refresh. */
export const CODEX_HOSTS: readonly string[] = ['chatgpt.com', 'openai.com'];

/** Variables that would make Codex bill an API key instead of the ChatGPT subscription. */
export const API_KEY_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const;

/** The arguments of one headless `codex exec` session: brief in, a JSONL event stream out. */
export interface CodexRun {
  brief: string;
  model: string;
  effort?: string;
}

/**
 * The words after `codex`. The bubblewrap sandbox and egress proxy around the session replace Codex's own sandbox, as
 * they replace Claude's permission prompts; the user config and rules stay unloaded, as `--setting-sources project`
 * keeps them out of a Claude arm; web search is off, as WebFetch and WebSearch are denied to a Claude arm.
 */
export function codexExecArgs(run: CodexRun): string[] {
  return [
    'exec',
    '--json',
    '--model',
    run.model,
    '--dangerously-bypass-approvals-and-sandbox',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--strict-config',
    '-c',
    'web_search="disabled"',
    '-c',
    `model_reasoning_effort="${run.effort ?? CODEX_EFFORT}"`,
    run.brief,
  ];
}

/** The host Codex home: `CODEX_HOME`, else `~/.codex`. */
export const codexHome = (
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string => env.CODEX_HOME ?? join(home, '.codex');

/**
 * Refuses a session that would bill an API key: an API key variable in its environment, or a host login that is not
 * a ChatGPT sign-in. Returns the host login file.
 */
export function subscriptionLogin(env: NodeJS.ProcessEnv): string {
  for (const k of API_KEY_VARS)
    if (env[k])
      throw new Error(`codex session refused: ${k} would bill an API key`);
  const auth = join(codexHome(env), 'auth.json');
  let mode: unknown;
  try {
    mode = (JSON.parse(readFileSync(auth, 'utf8')) as { auth_mode?: unknown })
      .auth_mode;
  } catch {
    throw new Error(`codex session refused: no readable login at ${auth}`);
  }
  if (mode !== 'chatgpt')
    throw new Error(
      `codex session refused: login mode ${String(mode)} is not a ChatGPT subscription`,
    );
  return auth;
}

/**
 * The session environment of a Codex arm: the shared isolated environment without API keys, and the private CODEX_HOME
 * `home` (one per session, so its rollouts are that session's alone) holding only a link to the host's ChatGPT login. Returns the environment and the paths the sandbox
 * must leave writable (the private home and the real login file, so a token refresh reaches the host login).
 */
export function codexSessionEnv(
  home: string,
  isolated: NodeJS.ProcessEnv,
  host: NodeJS.ProcessEnv,
): { env: NodeJS.ProcessEnv; writable: string[] } {
  const login = subscriptionLogin(host);
  const env: NodeJS.ProcessEnv = { ...isolated };
  for (const k of API_KEY_VARS) delete env[k];
  mkdirSync(home, { recursive: true });
  const link = join(home, 'auth.json');
  if (!existsSync(link)) symlinkSync(login, link);
  env.CODEX_HOME = home;
  return { env, writable: [home, realpathSync(login)] };
}

/** USD per million tokens. Cached input is part of input (the rollout's counts show it); reasoning is part of output. */
export interface CodexPrice {
  input: number;
  cachedInput: number;
  output: number;
}

/** List prices; cached input at a tenth of input. Notional: the session runs on subscription quota. */
export const CODEX_PRICES: Readonly<Record<string, CodexPrice>> = {
  'gpt-6.2-sol': { input: 2, cachedInput: 0.2, output: 10 },
};

export interface CodexUsage {
  input: number;
  cachedInput: number;
  output: number;
}

/** USD of `usage` at `model`'s list price; undefined for an unpriced model. */
export function codexCost(model: string, u: CodexUsage): number | undefined {
  const p = CODEX_PRICES[model];
  if (p === undefined) return undefined;
  const cached = Math.min(u.cachedInput, u.input);
  return (
    ((u.input - cached) * p.input +
      cached * p.cachedInput +
      u.output * p.output) /
    1e6
  );
}

const lines = (text: string): Record<string, unknown>[] =>
  text.split('\n').flatMap((l) => {
    if (l.trim() === '') return [];
    try {
      const v: unknown = JSON.parse(l);
      return typeof v === 'object' && v !== null && !Array.isArray(v)
        ? [v as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

/** What a session's rollout shows: the realized model(s) and the cumulative token count at its last report. */
export interface RolloutFacts {
  models: string[];
  usage: CodexUsage | undefined;
}

/** Reads one rollout file's text: models from `turn_context`, usage from the last cumulative `token_count`. */
export function rolloutFacts(text: string): RolloutFacts {
  const models = new Set<string>();
  let usage: CodexUsage | undefined;
  for (const l of lines(text)) {
    const p = obj(l.payload);
    if (l.type === 'turn_context' && typeof p.model === 'string')
      models.add(p.model);
    if (l.type === 'event_msg' && p.type === 'token_count') {
      const t = obj(obj(p.info).total_token_usage);
      if (Object.keys(t).length > 0)
        usage = {
          input: num(t.input_tokens),
          cachedInput: num(t.cached_input_tokens),
          output: num(t.output_tokens),
        };
    }
  }
  return { models: [...models].sort(), usage };
}

/** Every rollout file under a Codex home's `sessions` directory. */
export function rolloutFiles(home: string): string[] {
  const root = join(home, 'sessions');
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => join(root, f));
}

/** The result of one Codex session, in the shape the replay session driver reads. */
export interface CodexResult {
  ok: boolean;
  detail: string;
  cost: number | undefined;
  model?: string;
  turns?: number;
}

/**
 * Reads one `codex exec --json` session: its event stream (stdout) for success and failure, and the rollouts its
 * private home holds for the realized model and the cumulative usage, which a killed session still recorded. A failed
 * turn (a usage limit, an auth failure) or a session that never completed a turn is not ok, so the row counts as not
 * ran; an `error` event the session recovered from (a stream reconnect) does not fail it, but names a failure.
 */
export function parseCodexResult(
  stdout: string,
  stderr: string,
  rollouts: string[],
): CodexResult {
  const events = lines(stdout);
  const models = new Set<string>();
  let usage: CodexUsage | undefined;
  for (const text of rollouts) {
    const f = rolloutFacts(text);
    for (const m of f.models) models.add(m);
    if (f.usage)
      usage = usage
        ? {
            input: usage.input + f.usage.input,
            cachedInput: usage.cachedInput + f.usage.cachedInput,
            output: usage.output + f.usage.output,
          }
        : f.usage;
  }
  const model = models.size > 0 ? [...models].sort().join(',') : undefined;
  const cost =
    usage && models.size === 1 && model !== undefined
      ? codexCost(model, usage)
      : undefined;
  const turns = events.filter((e) => e.type === 'turn.completed').length;
  const failed = events.find((e) => e.type === 'turn.failed');
  const failure = failed ?? events.findLast((e) => e.type === 'error');
  const failText = failure
    ? String(obj(failure.error).message ?? failure.message ?? 'failed')
    : undefined;
  const ok = failed === undefined && turns > 0;
  return {
    ok,
    detail: ok
      ? 'codex session completed'
      : (failText ??
        (stderr.trim().split('\n').at(-1) ||
          'codex session ended without a turn')),
    cost,
    ...(model === undefined ? {} : { model }),
    turns,
  };
}
