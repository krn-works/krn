import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyBaseUrl } from './ctx-proxy-env.ts';

// Prove a change here against the live Herdr with
// `node scripts/claude/successor-probe.ts`: run by hand from a lead pane, the
// launcher renames the lead's tab and its successor's --retire closes the pane.

export interface SuccessorLaunchOptions {
  name: string;
  prompt: string;
  cwd: string;
  model?: string;
  effort?: Effort;
  startSeconds?: number;
}

// The operator capped every KRN session: medium by default, high when medium is
// not enough, xhigh at most; max is refused.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type Effort = (typeof EFFORTS)[number];

// How long a launch waits for Herdr to show the successor's agent, and how
// often it asks; a cold Claude start on a loaded host takes seconds.
const START_SECONDS = 60;
const POLL_SECONDS = 1;

function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

// A bounded wait in whole seconds, shared by the launch and retire modes.
function waitSeconds(value: string | undefined): number | undefined {
  return value !== undefined &&
    /^(0|[1-9]\d*)$/u.test(value) &&
    Number(value) <= 600
    ? Number(value)
    : undefined;
}

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type LaunchRecord = {
  pane_id: string;
  tab_id: string;
  session_id: string;
  name: string;
  recorded_at: string;
};

export type AgentInfo = {
  agent?: string | undefined;
  status?: string | undefined;
  sessionId?: string | undefined;
  tabId?: string | undefined;
  notFound?: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseArgs(
  args: string[],
  defaultCwd = process.cwd(),
): SuccessorLaunchOptions {
  let name: string | undefined;
  let prompt: string | undefined;
  let cwd = defaultCwd;
  let model: string | undefined;
  let effort: Effort | undefined;
  let startSeconds: number | undefined;
  const seen = new Set<string>();
  const flags = new Set([
    '--name',
    '--prompt',
    '--cwd',
    '--model',
    '--effort',
    '--start-seconds',
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? '';
    if (!flags.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    seen.add(flag);

    // A value may start with `--`; only a known flag marks a missing value.
    const value = args[index + 1];
    if (value === undefined || value === '' || flags.has(value))
      throw new Error(`expected a value after ${flag}`);
    index += 1;

    if (flag === '--name') name = value;
    else if (flag === '--prompt') prompt = value;
    else if (flag === '--model') model = value;
    else if (flag === '--effort') {
      if (value === 'max')
        throw new Error(
          '--effort max is refused: KRN sessions run at medium, high when medium is not enough, xhigh at most',
        );
      if (!isEffort(value))
        throw new Error(`--effort must be one of ${EFFORTS.join(', ')}`);
      effort = value;
    } else if (flag === '--start-seconds') {
      startSeconds = waitSeconds(value);
      if (startSeconds === undefined)
        throw new Error('--start-seconds must be a whole number from 0 to 600');
    } else cwd = resolve(defaultCwd, value);
  }

  if (!name) throw new Error('required argument missing: --name');
  if (!prompt) throw new Error('required argument missing: --prompt');
  // The SessionStart hook injects the handoff; a prompt that names it makes the
  // successor read it again (t-qdzy8w7: 81% of sessions re-read it).
  if (/handoff\.md|\bread\b[^.]*\bhandoff\b/iu.test(prompt))
    throw new Error(
      '--prompt must not tell the successor to read the handoff: the SessionStart hook injects it; say "run its Verify command" instead',
    );
  return {
    name,
    prompt,
    cwd,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(startSeconds === undefined ? {} : { startSeconds }),
  };
}

export function run(
  command: string,
  args: string[],
  cwd = process.cwd(),
  timeout = 15000,
  env?: NodeJS.ProcessEnv,
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    ...(env ? { env } : {}),
    encoding: 'utf8',
    timeout,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

function herdrFailure(result: CommandResult): string {
  if (result.error?.message.includes('ENOENT')) return 'herdr not on PATH';
  return 'server did not respond';
}

function serverIsRunning(output: string): boolean {
  return /^server:\s*\n\s+status:\s+running\s*$/mu.test(output);
}

function callerWorkspace(paneId: string): string | undefined {
  const result = run('herdr', ['pane', 'get', paneId]);
  if (result.status !== 0 || result.error) return undefined;
  try {
    const root = record(JSON.parse(result.stdout));
    const payload = record(root?.result);
    const pane = record(payload?.pane);
    return text(pane?.workspace_id);
  } catch {
    return undefined;
  }
}

export function paneInfo(output: string): {
  workspaceId?: string;
  tabId?: string;
} {
  try {
    const root = record(JSON.parse(output));
    const pane = record(record(root?.result)?.pane);
    const workspaceId = text(pane?.workspace_id);
    const tabId = text(pane?.tab_id);
    return {
      ...(workspaceId ? { workspaceId } : {}),
      ...(tabId ? { tabId } : {}),
    };
  } catch {
    return {};
  }
}

function sleep(seconds: number): void {
  if (seconds > 0)
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      seconds * 1000,
    );
}

export function retireMode(
  args: string[],
  pause: (seconds: number) => void = sleep,
  now: () => number = Date.now,
): number {
  let wait = 180;
  let cwd = process.cwd();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[++i];
    const seconds = waitSeconds(value);
    if (flag === '--wait-seconds' && seconds !== undefined) wait = seconds;
    else if (flag === '--cwd' && value) cwd = resolve(cwd, value);
    else {
      process.stderr.write('invalid retire arguments\n');
      return 64;
    }
  }
  if (!process.env.HERDR_PANE_ID) {
    process.stderr.write('retire: skipped: not in Herdr\n');
    return 0;
  }
  const ownPane = process.env.HERDR_PANE_ID;
  const ownResult = run('herdr', ['pane', 'get', ownPane]);
  const own =
    ownResult.status === 0 && !ownResult.error
      ? paneInfo(ownResult.stdout)
      : {};
  if (!own.workspaceId || !own.tabId) {
    process.stderr.write('retire: failed: own pane unavailable\n');
    return 0;
  }
  const predPane = process.env.KRN_PREDECESSOR_PANE;
  const predSession = process.env.KRN_PREDECESSOR_SESSION;
  if (predPane && predSession) {
    const deadline = now() + wait * 1000;
    for (;;) {
      const info = agentInfo(run('herdr', ['agent', 'get', predPane]));
      if (info.notFound || (info.sessionId && info.sessionId !== predSession))
        break;
      const settled = info.status === 'idle' || info.status === 'done';
      if (
        info.agent === 'claude' &&
        info.sessionId === predSession &&
        settled
      ) {
        const closed = run('herdr', ['pane', 'close', predPane]);
        process.stderr.write(
          `retire: ${closed.status === 0 && !closed.error ? 'closed' : 'failed to close'} predecessor ${predPane}\n`,
        );
        break;
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        process.stderr.write('retire: predecessor still working\n');
        break;
      }
      // A settled agent returns from the wait at once, so only a working one
      // is waited on; every other path pauses and keeps the loop bounded.
      if (settled || !waitUntilSettled(predPane, remaining))
        pause(Math.min(5, remaining / 1000));
    }
  }
  const ledgerPath = join(cwd, '.krn', 'successors', 'launches.jsonl');
  try {
    rewriteLedger(ledgerPath, retireLedger(readLaunches(ledgerPath), ownPane));
  } catch {
    process.stderr.write('retire: failed: ledger unavailable\n');
  }
  const list = run('herdr', ['tab', 'list', '--workspace', own.workspaceId]);
  try {
    const root = record(JSON.parse(list.stdout));
    const tabs = record(root?.result)?.tabs;
    if (list.status !== 0 || list.error || !Array.isArray(tabs))
      throw new Error();
    for (const value of tabs) {
      const tab = record(value);
      const id = text(tab?.tab_id);
      if (!id) continue;
      const eligible =
        typeof tab?.label === 'string' &&
        tab.label.startsWith('handed off → ') &&
        tab.workspace_id === own.workspaceId &&
        id !== own.tabId &&
        (tab.agent_status === 'idle' || tab.agent_status === 'done');
      if (eligible) {
        const closed = run('herdr', ['tab', 'close', id]);
        process.stderr.write(
          `retire: ${closed.status === 0 && !closed.error ? 'closed' : 'kept'} tab ${id}\n`,
        );
      } else process.stderr.write(`retire: kept tab ${id}\n`);
    }
  } catch {
    process.stderr.write('retire: failed: malformed tab list\n');
  }
  return 0;
}

// Herdr prints a reply on stdout and a server error as JSON on stderr with
// exit 1 (CLI reference; skill: "CLI server errors are JSON on stderr").
function replyOf(result: CommandResult): Record<string, unknown> | undefined {
  for (const stream of [result.stdout, result.stderr]) {
    try {
      const root = record(JSON.parse(stream));
      if (root) return root;
    } catch {}
  }
  return undefined;
}

export function agentInfo(result: CommandResult): AgentInfo {
  const root = replyOf(result);
  if (record(root?.error)?.code === 'agent_not_found')
    return { notFound: true };
  if (result.error || result.status !== 0) return {};

  const agent = record(record(root?.result)?.agent);
  const session = record(agent?.agent_session);
  return {
    agent: text(agent?.agent),
    status: text(agent?.agent_status),
    sessionId: text(session?.value),
    tabId: text(agent?.tab_id),
  };
}

/**
 * `herdr pane run` acknowledges admission, not command execution (official
 * herdr skill v0.9.5), so a launch counts as started only once Herdr shows
 * the expected agent in the new pane. That pane hosts only its shell, so when
 * Herdr cannot name the agent in advance (an override), any agent it reports
 * there is the successor. Herdr reports `unknown` while it cannot classify the
 * agent yet; a Claude held on its folder-trust dialog read `unknown` for
 * seconds, then `blocked` (Herdr 0.9.1 captures), so the wait runs on to the
 * first classified status. Answers the agent with that status, the agent still
 * `unknown` at the deadline, or undefined when no agent showed.
 */
export function awaitAgent(
  probe: () => AgentInfo,
  expected: string | undefined,
  seconds: number,
  pause: (seconds: number) => void = sleep,
  now: () => number = Date.now,
): AgentInfo | undefined {
  const deadline = now() + seconds * 1000;
  for (;;) {
    const info = probe();
    const shown =
      info.agent !== undefined &&
      (expected === undefined || info.agent === expected);
    if (shown && info.status !== undefined && info.status !== 'unknown')
      return info;
    const remaining = deadline - now();
    if (remaining <= 0) return shown ? info : undefined;
    pause(Math.min(POLL_SECONDS, remaining / 1000));
  }
}

// `herdr agent wait` blocks on the server until the agent is idle or done; its
// own timeout and any other failure answer false.
function waitUntilSettled(paneId: string, timeoutMs: number): boolean {
  const milliseconds = Math.max(1, Math.ceil(timeoutMs));
  const result = run(
    'herdr',
    [
      'agent',
      'wait',
      paneId,
      '--until',
      'idle',
      '--until',
      'done',
      '--timeout',
      String(milliseconds),
    ],
    undefined,
    milliseconds + 5000,
  );
  return result.status === 0 && !result.error;
}

// Malformed lines are skipped one by one so a damaged entry never stops
// the retirement of the valid ones.
function readLaunches(path: string): LaunchRecord[] {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (record(error)?.code === 'ENOENT') return [];
    throw error;
  }

  const launches: LaunchRecord[] = [];
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = record(JSON.parse(line));
      const paneId = text(value?.pane_id);
      const tabId = text(value?.tab_id);
      const sessionId = text(value?.session_id);
      const name = text(value?.name);
      const recordedAt = text(value?.recorded_at);
      if (!paneId || !tabId || !sessionId || !name || !recordedAt) continue;
      launches.push({
        pane_id: paneId,
        tab_id: tabId,
        session_id: sessionId,
        name,
        recorded_at: recordedAt,
      });
    } catch {}
  }
  return launches;
}

function retireLedger(
  launches: LaunchRecord[],
  callerPaneId: string,
): LaunchRecord[] {
  const kept: LaunchRecord[] = [];
  for (const launch of launches) {
    if (launch.pane_id === callerPaneId) continue;
    const result = run('herdr', ['agent', 'get', launch.pane_id]);
    const info = agentInfo(result);
    if (info.notFound) continue;
    if (result.error || result.status !== 0) {
      kept.push(launch);
      continue;
    }
    if (info.sessionId && info.sessionId !== launch.session_id) continue;
    if (
      info.agent === 'claude' &&
      info.sessionId === launch.session_id &&
      (info.status === 'idle' || info.status === 'done')
    ) {
      const closed = run('herdr', ['pane', 'close', launch.pane_id]);
      if (!closed.error && closed.status === 0) {
        process.stdout.write(
          `retired: pane ${launch.pane_id} session ${launch.session_id}\n`,
        );
        continue;
      }
      process.stderr.write(
        `successor retirement failed: pane ${launch.pane_id}\n`,
      );
    }
    kept.push(launch);
  }
  return kept;
}

function rewriteLedger(ledgerPath: string, launches: LaunchRecord[]): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(
    ledgerPath,
    `${launches.map((launch) => JSON.stringify(launch)).join('\n')}\n`,
  );
}

function retirePredecessors(
  options: SuccessorLaunchOptions,
  callerPaneId: string,
): void {
  const caller = agentInfo(run('herdr', ['agent', 'get', callerPaneId]));
  if (
    caller.agent !== 'claude' ||
    !caller.sessionId ||
    !caller.tabId ||
    caller.notFound
  ) {
    process.stderr.write(
      'successor retirement skipped: caller agent unavailable\n',
    );
    return;
  }

  const ledgerPath = join(options.cwd, '.krn', 'successors', 'launches.jsonl');
  let launches: LaunchRecord[];
  try {
    launches = readLaunches(ledgerPath);
  } catch {
    process.stderr.write('successor retirement skipped: ledger unavailable\n');
    return;
  }

  const kept = retireLedger(launches, callerPaneId);

  const rename = run('herdr', [
    'tab',
    'rename',
    caller.tabId,
    `handed off → ${options.name}`,
  ]);
  if (rename.error || rename.status !== 0)
    process.stderr.write(`successor retirement failed: tab ${caller.tabId}\n`);

  const callerLaunch: LaunchRecord = {
    pane_id: callerPaneId,
    tab_id: caller.tabId,
    session_id: caller.sessionId,
    name: options.name,
    recorded_at: new Date().toISOString(),
  };
  const serialized = [...kept, callerLaunch]
    .map((launch) => JSON.stringify(launch))
    .join('\n');
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, `${serialized}\n`);
  } catch {
    process.stderr.write('successor retirement failed: ledger write\n');
  }
}

export function createdIds(
  output: string,
): { tabId: string; paneId: string; workspaceId?: string } | undefined {
  try {
    const root = record(JSON.parse(output));
    const payload = record(root?.result);
    const tab = record(payload?.tab);
    const pane = record(payload?.root_pane);
    const tabId = text(tab?.tab_id);
    const paneId = text(pane?.pane_id);
    const workspaceId = text(tab?.workspace_id);
    return tabId && paneId
      ? { tabId, paneId, ...(workspaceId ? { workspaceId } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

function exitFailure(result: CommandResult): number {
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    return 1;
  }
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== null && result.status !== 0) {
    if (!result.stderr)
      process.stderr.write(`command exited with status ${result.status}\n`);
    return result.status;
  }
  return 1;
}

export type Harness = 'claude' | 'codex' | 'other';

/**
 * The harness the lead is running in, read from the runtime environment.
 * KRN_SUCCESSOR_AGENT is an explicit operator override; otherwise the
 * variables each harness exports to its child processes decide. An unknown
 * or ambiguous environment returns an error instead of a guess.
 */
export function detectHarness(
  env: NodeJS.ProcessEnv,
): { agent: string; harness: Harness } | { error: string } {
  const override = env.KRN_SUCCESSOR_AGENT;
  if (override)
    return {
      agent: override,
      harness:
        basename(override) === 'codex'
          ? 'codex'
          : basename(override) === 'claude'
            ? 'claude'
            : 'other',
    };
  const codex = Boolean(
    env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_CI,
  );
  const claude = env.CLAUDECODE === '1' || Boolean(env.CLAUDE_CODE_SESSION_ID);
  if (codex && claude)
    return {
      error:
        'ambiguous harness: both Codex and Claude Code markers are set; set KRN_SUCCESSOR_AGENT',
    };
  if (codex) return { agent: 'codex', harness: 'codex' };
  if (claude) return { agent: 'claude', harness: 'claude' };
  return {
    error:
      'unknown harness: no Codex or Claude Code marker in the environment; set KRN_SUCCESSOR_AGENT',
  };
}

// `proxy` is the context proxy's base URL when it is healthy (see
// ctx-proxy-env.ts); a Claude successor then routes through it.
export function main(args: string[], proxy?: string): number {
  if (args[0] === '--retire') return retireMode(args.slice(1));
  let options: SuccessorLaunchOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'invalid arguments'}\n`,
    );
    return 2;
  }

  const detected = detectHarness(process.env);
  if ('error' in detected) {
    process.stderr.write(`${detected.error}\n`);
    return 2;
  }
  const { agent, harness } = detected;

  const status = run('herdr', ['status']);
  const paneId = process.env.HERDR_PANE_ID;
  let unavailable: string | undefined;
  let workspaceId: string | undefined;

  if (status.error || status.status !== 0 || !serverIsRunning(status.stdout))
    unavailable = herdrFailure(status);
  else if (paneId) {
    workspaceId = callerWorkspace(paneId);
    if (!workspaceId) unavailable = 'caller pane unavailable';
  }

  // Operator 2026-11-06 (t-5av8etp): a relayed Claude lead never stops on
  // permission prompts; other agents keep their own defaults.
  // Operator 2026-11-01 (t-h7xt8m3): krn-handoff passes the successor's
  // model and effort; only Claude takes these flags.
  if (harness !== 'claude' && (options.model || options.effort)) {
    process.stderr.write(
      '--model and --effort apply only to Claude successors\n',
    );
    return 2;
  }
  const agentFlags =
    harness === 'claude'
      ? [
          '--permission-mode',
          'bypassPermissions',
          ...(options.model ? ['--model', options.model] : []),
          ...(options.effort ? ['--effort', options.effort] : []),
        ]
      : [];
  const proxied = harness === 'claude' ? proxy : undefined;
  const prompt = `First run \`node scripts/claude/successor-launch.ts --retire\` from the repository root. ${options.prompt}`;
  if (unavailable && harness === 'codex') {
    // Codex has no background mode; never start Claude in its place.
    process.stderr.write(
      `codex successor needs Herdr (${unavailable}); no background launch exists\n`,
    );
    return 1;
  }
  if (unavailable) {
    const fallback = run(
      agent,
      [...agentFlags, '--bg', '-n', options.name, prompt],
      options.cwd,
      15000,
      proxied ? { ...process.env, ANTHROPIC_BASE_URL: proxied } : undefined,
    );
    if (fallback.error || fallback.status !== 0) return exitFailure(fallback);
    process.stdout.write(
      `successor: claude --bg (herdr unavailable: ${unavailable})\n`,
    );
    return 0;
  }

  const createArgs = ['tab', 'create'];
  if (workspaceId) createArgs.push('--workspace', workspaceId);
  // `herdr pane run` types its words into the pane's shell, so the agent,
  // name and prompt travel as tab environment and the shell expands them.
  createArgs.push(
    '--cwd',
    options.cwd,
    '--label',
    options.name,
    '--env',
    `KRN_SUCCESSOR_AGENT=${agent}`,
    '--env',
    `KRN_SUCCESSOR_NAME=${options.name}`,
    '--env',
    `KRN_SUCCESSOR_PROMPT=${prompt}`,
  );
  if (proxied) createArgs.push('--env', `ANTHROPIC_BASE_URL=${proxied}`);
  let predecessorSession: string | undefined;
  if (paneId && workspaceId) {
    predecessorSession = agentInfo(
      run('herdr', ['agent', 'get', paneId]),
    ).sessionId;
    if (predecessorSession)
      createArgs.push(
        '--env',
        `KRN_PREDECESSOR_PANE=${paneId}`,
        '--env',
        `KRN_PREDECESSOR_SESSION=${predecessorSession}`,
      );
  }
  createArgs.push('--no-focus');
  const created = run('herdr', createArgs);
  if (created.error || created.status !== 0) return exitFailure(created);

  const ids = createdIds(created.stdout);
  if (!ids) {
    process.stderr.write('herdr tab create returned no tab or pane id\n');
    return 1;
  }

  const started = run('herdr', [
    'pane',
    'run',
    ids.paneId,
    '"$KRN_SUCCESSOR_AGENT"',
    ...agentFlags,
    // Codex has no session-name flag; the Herdr tab label carries the name.
    ...(harness !== 'codex' ? ['-n', '"$KRN_SUCCESSOR_NAME"'] : []),
    '"$KRN_SUCCESSOR_PROMPT"',
  ]);
  if (started.error || started.status !== 0) return exitFailure(started);

  // Herdr names claude and codex itself; an override's binary may be a
  // wrapper, so only Herdr's own kinds are matched by name.
  const expected = harness === 'other' ? undefined : harness;
  const seconds = options.startSeconds ?? START_SECONDS;
  const successor = awaitAgent(
    () => agentInfo(run('herdr', ['agent', 'get', ids.paneId])),
    expected,
    seconds,
  );
  if (!successor) {
    process.stderr.write(
      `successor not started: herdr pane ${ids.paneId} shows no ${expected ? `${expected} ` : ''}agent after ${seconds} s; tab ${ids.tabId} kept for inspection\n`,
    );
    return 1;
  }

  process.stdout.write(
    `successor: herdr tab ${ids.tabId} pane ${ids.paneId} agent ${successor.agent} ${successor.status ?? 'unknown'}\n`,
  );
  // A startup dialog (folder trust, an MCP approval, a login) holds a live
  // successor before its prompt. Failing the launch would invite a duplicate
  // successor, so the handoff stands and the operator learns the pane.
  if (successor.status === 'blocked')
    process.stderr.write(
      `successor waits on a startup dialog: answer it in herdr pane ${ids.paneId} (tab ${ids.tabId})\n`,
    );
  if (paneId) retirePredecessors(options, paneId);
  return 0;
}

// The main checkout owns .krn/runs; a lane worktree shares it through git.
function root(): string {
  const common = run('git', [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  return common.status === 0 ? dirname(common.stdout.trim()) : process.cwd();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const proxy =
    args[0] === '--retire'
      ? undefined
      : await proxyBaseUrl(process.env, root());
  process.exitCode = main(args, proxy);
}
