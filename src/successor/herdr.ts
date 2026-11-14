// Herdr pane control.
import { spawnSync } from 'node:child_process';

// Herdr pane control: run commands, read panes, agents and process info, wait for an agent to show.
// Every reader answers an empty or undefined value for a reply it cannot parse.

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type AgentInfo = {
  agent?: string | undefined;
  status?: string | undefined;
  sessionId?: string | undefined;
  tabId?: string | undefined;
  notFound?: boolean;
};

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

export function herdrFailure(result: CommandResult): string {
  if (result.error?.message.includes('ENOENT')) return 'herdr not on PATH';
  return 'server did not respond';
}

export function serverIsRunning(output: string): boolean {
  return /^server:\s*\n\s+status:\s+running\s*$/mu.test(output);
}

export function callerWorkspace(paneId: string): string | undefined {
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

export function sleep(seconds: number): void {
  if (seconds > 0)
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      seconds * 1000,
    );
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

// A pane hosts running work when Herdr lists a foreground process other than
// the agent, or the agent process has a live child shell (a background
// monitor). `pane process-info` lists foreground processes only, so children
// come from the process table. A pane Herdr cannot report on is not held.
export function hostsRunningWork(paneId: string): boolean {
  const result = run('herdr', ['pane', 'process-info', '--pane', paneId]);
  if (result.status !== 0 || result.error) return false;
  try {
    const root = record(JSON.parse(result.stdout));
    const info = record(record(root?.result)?.process_info);
    const processes = info?.foreground_processes;
    if (!Array.isArray(processes)) return false;
    for (const value of processes) {
      const process = record(value);
      if (process?.name !== 'claude') return true;
      const pid = process.pid;
      if (typeof pid !== 'number') continue;
      const children = run('ps', ['-o', 'pid=,comm=', '--ppid', String(pid)]);
      for (const line of children.stdout.split('\n')) {
        const command = line.trim().split(/\s+/u).pop();
        if (command && SHELLS.has(command)) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function keptRunning(paneId: string): boolean {
  if (!hostsRunningWork(paneId)) return false;
  process.stderr.write(`retire: kept ${paneId}: running work\n`);
  return true;
}

export function runningPaneInTab(
  workspaceId: string,
  tabId: string,
): string | undefined {
  const list = run('herdr', ['pane', 'list', '--workspace', workspaceId]);
  if (list.status !== 0 || list.error) return undefined;
  try {
    const panes = record(record(JSON.parse(list.stdout))?.result)?.panes;
    if (!Array.isArray(panes)) return undefined;
    for (const value of panes) {
      const pane = record(value);
      const id = text(pane?.pane_id);
      if (id && pane?.tab_id === tabId && keptRunning(id)) return id;
    }
  } catch {}
  return undefined;
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
export function waitUntilSettled(paneId: string, timeoutMs: number): boolean {
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

export function exitFailure(result: CommandResult): number {
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

// How often a launch asks Herdr whether the successor's agent has shown.
const POLL_SECONDS = 1;
