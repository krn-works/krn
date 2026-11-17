// The Herdr adapter of the terminal host port: the only module that runs
// `herdr`, names its flags or reads its replies. Every reader answers an empty
// or undefined value for a reply it cannot parse.

import { claudeAgent } from '../harness/claude.ts';
import { readJson } from '../repo/json-text.ts';
import {
  type CommandResult,
  hasChildShell,
  record,
  run,
  text,
} from './command.ts';
import { failureOf, succeeded } from './host-failure.ts';
import type {
  AgentInfo,
  HostFailure,
  Opened,
  ScopeRef,
  SessionRef,
  TabRef,
  TerminalHost,
} from './terminal-host.ts';

function herdrFailure(result: CommandResult): string {
  if (result.error?.message.includes('ENOENT')) return 'herdr not on PATH';
  return 'server did not respond';
}

function serverIsRunning(output: string): boolean {
  return /^server:\s*\n\s+status:\s+running\s*$/mu.test(output);
}

// Herdr prints a server error as JSON on stderr with exit 1; name its code.
function failureReason(result: CommandResult): string {
  if (result.error)
    return result.error.message.includes('ENOENT')
      ? 'herdr not on PATH'
      : result.error.message;
  const code = record(record(readJson(result.stderr))?.error)?.code;
  if (typeof code === 'string') return code;
  return result.stderr.trim() || `exit ${result.status}`;
}

function hostFailure(result: CommandResult): HostFailure {
  return failureOf(result, failureReason(result));
}

function outcome(result: CommandResult): HostFailure | undefined {
  return succeeded(result) ? undefined : hostFailure(result);
}

function paneInfo(output: string): { scope?: ScopeRef; tab?: TabRef } {
  try {
    const root = record(JSON.parse(output));
    const pane = record(record(root?.result)?.pane);
    const scope = text(pane?.workspace_id) as ScopeRef | undefined;
    const tab = text(pane?.tab_id) as TabRef | undefined;
    return { ...(scope ? { scope } : {}), ...(tab ? { tab } : {}) };
  } catch {
    return {};
  }
}

// A pane hosts running work when Herdr lists a foreground process other than
// the agent, or the agent process has a live child shell (a background
// monitor). `pane process-info` lists foreground processes only, so children
// come from the process table. A pane Herdr cannot report on is not held.
export function hostsRunningWork(paneId: string): boolean {
  const result = run('herdr', ['pane', 'process-info', '--pane', paneId]);
  if (!succeeded(result)) return false;
  try {
    const root = record(JSON.parse(result.stdout));
    const info = record(record(root?.result)?.process_info);
    const processes = info?.foreground_processes;
    if (!Array.isArray(processes)) return false;
    for (const value of processes) {
      const process = record(value);
      if (process?.name !== claudeAgent) return true;
      const pid = process.pid;
      if (typeof pid !== 'number') continue;
      if (hasChildShell(pid)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

// Herdr prints a reply on stdout and a server error as JSON on stderr with
// exit 1 (CLI reference; skill: "CLI server errors are JSON on stderr").
function replyOf(result: CommandResult): Record<string, unknown> | undefined {
  for (const stream of [result.stdout, result.stderr]) {
    const root = record(readJson(stream));
    if (root) return root;
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
    tabId: text(agent?.tab_id) as TabRef | undefined,
  };
}

function createdIds(output: string): Opened | undefined {
  try {
    const root = record(JSON.parse(output));
    const payload = record(root?.result);
    const tab = record(payload?.tab);
    const pane = record(payload?.root_pane);
    const tabId = text(tab?.tab_id);
    const paneId = text(pane?.pane_id);
    const scope = text(tab?.workspace_id);
    return tabId && paneId
      ? {
          tab: tabId as TabRef,
          session: paneId as SessionRef,
          ...(scope ? { scope: scope as ScopeRef } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function panesOf(
  scope: ScopeRef,
): Array<{ id: string; tab: unknown }> | undefined {
  const list = run('herdr', ['pane', 'list', '--workspace', scope]);
  if (!succeeded(list)) return undefined;
  const panes = record(record(readJson(list.stdout))?.result)?.panes;
  if (!Array.isArray(panes)) return undefined;
  const found: Array<{ id: string; tab: unknown }> = [];
  for (const value of panes) {
    const pane = record(value);
    const id = text(pane?.pane_id);
    if (id) found.push({ id, tab: pane?.tab_id });
  }
  return found;
}

export function herdrHost(env: NodeJS.ProcessEnv = process.env): TerminalHost {
  return {
    name: 'herdr',
    status() {
      const status = run('herdr', ['status']);
      if (
        status.error ||
        status.status !== 0 ||
        !serverIsRunning(status.stdout)
      )
        return herdrFailure(status);
      return undefined;
    },
    self() {
      return env.HERDR_PANE_ID ? (env.HERDR_PANE_ID as SessionRef) : undefined;
    },
    session: (id) => id as SessionRef,
    tab: (id) => id as TabRef,
    place(session) {
      const result = run('herdr', ['pane', 'get', session]);
      return succeeded(result) ? paneInfo(result.stdout) : {};
    },
    open({ scope, cwd, label, env: tabEnv }) {
      // `herdr pane run` types its words into the pane's shell, so values the
      // shell must expand travel as tab environment.
      const args = ['tab', 'create'];
      if (scope) args.push('--workspace', scope);
      args.push('--cwd', cwd, '--label', label);
      for (const [name, value] of Object.entries(tabEnv))
        args.push('--env', `${name}=${value}`);
      args.push('--no-focus');
      const created = run('herdr', args);
      if (!succeeded(created)) return hostFailure(created);
      const opened = createdIds(created.stdout);
      return (
        opened ?? {
          exit: 1,
          stderr: 'herdr tab create returned no tab or pane id\n',
          reason: 'no tab or pane id',
        }
      );
    },
    type(session, words) {
      const typed = run('herdr', ['pane', 'run', session, ...words]);
      return succeeded(typed) ? undefined : hostFailure(typed);
    },
    agent: (session) => agentInfo(run('herdr', ['agent', 'get', session])),
    // `herdr agent wait` blocks on the server until the agent is idle or done;
    // its own timeout and any other failure answer false.
    wait(session, timeoutMs) {
      const milliseconds = Math.max(1, Math.ceil(timeoutMs));
      const result = run(
        'herdr',
        [
          'agent',
          'wait',
          session,
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
      return succeeded(result);
    },
    busy: hostsRunningWork,
    list(scope) {
      const list = run('herdr', ['tab', 'list', '--workspace', scope]);
      try {
        const tabs = record(record(JSON.parse(list.stdout))?.result)?.tabs;
        if (!succeeded(list)) return hostFailure(list);
        if (!Array.isArray(tabs)) throw new Error('no tabs');
        const found = [];
        for (const value of tabs) {
          const tab = record(value);
          const id = text(tab?.tab_id);
          if (!id) continue;
          const workspace = text(tab?.workspace_id);
          found.push({
            tab: id as TabRef,
            ...(typeof tab?.label === 'string' ? { label: tab.label } : {}),
            ...(workspace ? { scope: workspace as ScopeRef } : {}),
            ...(typeof tab?.agent_status === 'string'
              ? { status: tab.agent_status }
              : {}),
            sessions: () =>
              panesOf(scope)
                ?.filter((pane) => pane.tab === id)
                .map((pane) => pane.id as SessionRef),
          });
        }
        return found;
      } catch {
        return hostFailure(list);
      }
    },
    close: (session) => outcome(run('herdr', ['pane', 'close', session])),
    closeTab: (tab) => outcome(run('herdr', ['tab', 'close', tab])),
    rename: (tab, label) =>
      outcome(run('herdr', ['tab', 'rename', tab, label])),
    // Only hc keeps finished terminals listed until they are removed.
    removeFinished: () => [],
  };
}
