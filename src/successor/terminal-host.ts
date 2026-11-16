import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
// The terminal host port: how the successor modules open, watch and close
// agent sessions without knowing which terminal multiplexer hosts them.

import { sleep } from './command.ts';
import { hcHost } from './host-hc.ts';
import { herdrHost } from './host-herdr.ts';

declare const refBrand: unique symbol;
/** A running agent session in the host (Herdr: a pane). Opaque outside its adapter. */
export type SessionRef = string & { readonly [refBrand]: 'session' };
/** A group of sessions the host can label and close together (Herdr: a tab). */
export type TabRef = string & { readonly [refBrand]: 'tab' };
/** The space tabs belong to (Herdr: a workspace). */
export type ScopeRef = string & { readonly [refBrand]: 'scope' };

export type AgentInfo = {
  agent?: string | undefined;
  status?: string | undefined;
  sessionId?: string | undefined;
  tabId?: TabRef | undefined;
  notFound?: boolean;
};

/** Why a host call failed: the exit code to end with, what to print, a one-line reason. */
export type HostFailure = { exit: number; stderr: string; reason: string };

export type Opened = { tab: TabRef; session: SessionRef; scope?: ScopeRef };

export type TabInfo = {
  tab: TabRef;
  label?: string;
  scope?: ScopeRef;
  status?: string;
};

export type TerminalHost = {
  /** Printed in launcher messages: "successor: herdr tab ... pane ...". */
  readonly name: string;
  /** Undefined when the host answers; else why it is unavailable. */
  status(): string | undefined;
  /** The session the current process runs in, from the environment. */
  self(): SessionRef | undefined;
  /** Rebuilds a session or tab reference from the id a ledger or env kept. */
  session(id: string): SessionRef;
  tab(id: string): TabRef;
  /** Where a session lives; empty when the host cannot say. */
  place(session: SessionRef): { scope?: ScopeRef; tab?: TabRef };
  /** A new unfocused tab with a shell in `cwd`, `env` set and a label. */
  open(input: {
    scope?: ScopeRef | undefined;
    cwd: string;
    label: string;
    env: Record<string, string>;
  }): Opened | HostFailure;
  /** Types the words into the session's shell; the shell expands them. */
  type(session: SessionRef, words: string[]): HostFailure | undefined;
  agent(session: SessionRef): AgentInfo;
  /** Blocks until the agent is idle or done; false on timeout or failure. */
  wait(session: SessionRef, timeoutMs: number): boolean;
  /** Whether the session hosts running work besides its idle agent. */
  busy(session: SessionRef): boolean;
  /** Tabs of a scope with their sessions; a failure when the list is unreadable. */
  list(
    scope: ScopeRef,
  ): Array<TabInfo & { sessions(): SessionRef[] | undefined }> | HostFailure;
  /** Each answers undefined once done, else why not. */
  close(session: SessionRef): HostFailure | undefined;
  closeTab(tab: TabRef): HostFailure | undefined;
  rename(tab: TabRef, label: string): HostFailure | undefined;
};

export function isFailure(value: unknown): value is HostFailure {
  return typeof value === 'object' && value !== null && 'exit' in value;
}

// The Herdr desktop app (hc) hosts the terminal named by HC_TERMINAL_ID; the
// Herdr multiplexer the pane named by HERDR_PANE_ID. A terminal started by hc
// inherits the core's HERDR_* variables (observed with hc 0.1.20), so
// HC_TERMINAL_ID wins when both are set. The app is the baseline host: a relay
// started from the Herdr multiplexer still opens its successor in the app when
// hc is on PATH; KRN_TERMINAL_HOST=herdr keeps the multiplexer (t-af0fgyh).
export function selectHost(env: NodeJS.ProcessEnv = process.env): TerminalHost {
  if (env.HC_TERMINAL_ID) return hcHost(env);
  if (env.KRN_TERMINAL_HOST !== 'herdr' && onPath('hc', env))
    return hcHost(env);
  return herdrHost(env);
}

// How often a launch asks the host whether the successor's agent has shown.
const POLL_SECONDS = 1;

/**
 * Starting an agent is admitted before it runs, so a launch counts as started
 * only once the host shows the expected agent in the new session. That session
 * hosts only its shell, so when the host cannot name the agent in advance (an
 * override), any agent it reports there is the successor. Herdr reports
 * `unknown` while it cannot classify the agent yet; a Claude held on its
 * folder-trust dialog read `unknown` for seconds, then `blocked` (Herdr 0.9.1
 * captures), so the wait runs on to the first classified status. Answers the
 * agent with that status, the agent still `unknown` at the deadline, or
 * undefined when no agent showed.
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

/** The launcher's stdout line naming the successor's tab and session. */
export function announcement(
  host: TerminalHost,
  ids: { tab: TabRef; session: SessionRef },
  agent: string,
  status: string,
): string {
  return `successor: ${host.name} tab ${ids.tab} pane ${ids.session} agent ${agent} ${status}`;
}

export function parseAnnouncement(
  host: TerminalHost,
  stdout: string,
): { tab: TabRef; session: SessionRef } | undefined {
  const match = new RegExp(
    `^successor: ${host.name} tab (\\S+) pane (\\S+) agent \\S+ \\S+$`,
    'mu',
  ).exec(stdout);
  return match?.[1] && match[2]
    ? { tab: host.tab(match[1]), session: host.session(match[2]) }
    : undefined;
}

function onPath(program: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(delimiter).some((dir) => {
    if (dir === '') return false;
    try {
      accessSync(join(dir, program), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
