// The Herdr desktop (hc) adapter of the terminal host port: the only module
// that runs `hc`, names its flags or reads its replies. hc has terminals and
// no tabs or workspaces, so a session, its tab and the scope's one core are
// the same terminal address (`t7`) and a fixed scope. A tab's label lives in
// the terminal label `krn-tab`. Every reader answers an empty or undefined
// value for a reply it cannot parse.

import { basename } from 'node:path';
import { claudeAgent } from '../harness/claude.ts';
import { readJson } from '../repo/json-text.ts';
import {
  type CommandResult,
  hasChildShell,
  isShell,
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

// One core serves every terminal, so every terminal lives in this one scope.
const SCOPE = 'hc' as ScopeRef;
// The terminal label that carries the tab label the launcher and retire read.
const TAB_LABEL = 'krn-tab';
// The labels that put an hc terminal in the Herdr desktop window: a terminal
// with `herdr.space` opens as a new tab of that space; without it the window
// never shows the terminal (`herdr-app --skill`).
const SPACE_LABEL = 'herdr.space';
// The marker Claude Code sets for its child processes; a Claude started
// with it saves no transcript.
const CHILD_SESSION = 'CLAUDE_CODE_CHILD_SESSION';
// hc reports `not_found` with exit 3 for an address it does not hold.
const NOT_FOUND = 'not_found';

// hc prints a reply on stdout and an error as JSON on stderr.
function failureReason(result: CommandResult): string {
  if (result.error)
    return result.error.message.includes('ENOENT')
      ? 'hc not on PATH'
      : result.error.message;
  const kind = record(record(readJson(result.stderr))?.error)?.kind;
  if (typeof kind === 'string') return kind;
  return result.stderr.trim() || `exit ${result.status}`;
}

function hostFailure(result: CommandResult): HostFailure {
  return failureOf(result, failureReason(result));
}

function outcome(result: CommandResult): HostFailure | undefined {
  return succeeded(result) ? undefined : hostFailure(result);
}

function terminalOf(
  result: CommandResult,
): Record<string, unknown> | undefined {
  return succeeded(result) ? record(readJson(result.stdout)) : undefined;
}

/** A live terminal, or undefined when hc cannot show one at that address. */
function liveTerminal(address: string): Record<string, unknown> | undefined {
  const terminal = terminalOf(run('hc', ['get', address]));
  return terminal?.state === 'live' ? terminal : undefined;
}

function agentInfo(address: string, result: CommandResult): AgentInfo {
  if (failureReason(result) === NOT_FOUND) return { notFound: true };
  const terminal = terminalOf(result);
  if (!terminal) return {};
  // A finished terminal no longer hosts anything.
  if (terminal.state === 'finished') return { notFound: true };
  const program = text(record(terminal.foreground)?.name);
  const created = terminal.created_ms;
  return {
    agent: program,
    // A program that never reported (a shell, a Claude on its trust dialog)
    // has no status.
    status: text(record(terminal.status)?.state),
    // hc exposes no agent session id; the terminal incarnation tells a
    // replaced terminal from the one a ledger kept.
    ...(typeof created === 'number'
      ? { sessionId: `${address}@${created}` }
      : {}),
    tabId: address as TabRef,
  };
}

/**
 * The window space a successor opens in, so the operator sees it as a tab:
 * the caller's own space, else the space whose folder is the successor's
 * folder, else a new one for that folder. Undefined when the window cannot
 * answer: the successor then runs hidden, as every unlabelled hc terminal.
 */
function windowSpace(
  self: string | undefined,
  cwd: string,
): string | undefined {
  const own = self
    ? record(liveTerminal(self)?.labels)?.[SPACE_LABEL]
    : undefined;
  if (typeof own === 'string' && own) return own;
  const list = run('herdr-app', ['ls']);
  if (!succeeded(list)) return undefined;
  const spaces = record(readJson(list.stdout))?.spaces;
  if (!Array.isArray(spaces)) return undefined;
  for (const value of spaces) {
    const space = record(value);
    if (space?.folder === cwd && space.machine == null) {
      const id = text(space.id);
      if (id) return id;
    }
  }
  const created = run('herdr-app', [
    'do',
    'space.new',
    '--name',
    basename(cwd) || cwd,
    '--folder',
    cwd,
  ]);
  return succeeded(created)
    ? text(record(readJson(created.stdout))?.space)
    : undefined;
}

function listing(): Array<Record<string, unknown>> | HostFailure {
  const list = run('hc', ['ls']);
  if (!succeeded(list)) return hostFailure(list);
  const terminals = record(readJson(list.stdout))?.terminals;
  if (!Array.isArray(terminals))
    return failureOf(list, 'malformed terminal list');
  const found: Array<Record<string, unknown>> = [];
  for (const value of terminals) {
    const summary = record(value);
    if (summary) found.push(summary);
  }
  return found;
}

export function hcHost(env: NodeJS.ProcessEnv = process.env): TerminalHost {
  return {
    name: 'hc',
    status() {
      const status = run('hc', ['server', 'status']);
      if (status.error || status.status !== 0)
        return failureReason(status) === 'hc not on PATH'
          ? 'hc not on PATH'
          : 'server did not respond';
      return record(record(readJson(status.stdout))?.core)
        ? undefined
        : 'server did not respond';
    },
    self() {
      return env.HC_TERMINAL_ID
        ? (env.HC_TERMINAL_ID as SessionRef)
        : undefined;
    },
    session: (id) => id as SessionRef,
    tab: (id) => id as TabRef,
    place(session) {
      return liveTerminal(session)
        ? { scope: SCOPE, tab: session as string as TabRef }
        : {};
    },
    open({ cwd, label, env: tabEnv }) {
      // hc starts a program, not a shell with environment, so `env` carries
      // the values the typed words expand. No parent: the successor must
      // outlive the predecessor, which retire closes.
      const args = ['run', '--bg', '--no-parent', '--cwd', cwd];
      args.push('--label', `${TAB_LABEL}=${label}`);
      const space = windowSpace(env.HC_TERMINAL_ID, cwd);
      if (space) args.push('--label', `${SPACE_LABEL}=${space}`);
      args.push('--');
      // A core started from inside Claude Code hands every terminal the
      // child-session marker, and a Claude that inherits it saves no
      // transcript, so the ledger would lose the successor.
      args.push('env', '-u', CHILD_SESSION);
      args.push(...Object.entries(tabEnv).map(([k, v]) => `${k}=${v}`));
      args.push('bash');
      const created = run('hc', args);
      if (!succeeded(created)) return hostFailure(created);
      const address = text(terminalOf(created)?.address);
      if (!address)
        return {
          exit: 1,
          stderr: 'hc run returned no terminal address\n',
          reason: 'no terminal address',
        } satisfies HostFailure;
      return {
        tab: address as TabRef,
        session: address as SessionRef,
        scope: SCOPE,
      } satisfies Opened;
    },
    type(session, words) {
      return outcome(run('hc', ['send', session, words.join(' ')]));
    },
    agent: (session) => agentInfo(session, run('hc', ['get', session])),
    // `hc wait` ends when the program stops working; only a settled agent or
    // an ended terminal counts, a block or a timeout answers false.
    wait(session, timeoutMs) {
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      const result = run(
        'hc',
        ['wait', session, '--timeout', String(seconds)],
        undefined,
        (seconds + 5) * 1000,
      );
      const reply = terminalOf(result);
      if (reply?.ended !== true) return false;
      return (
        reply.reason === 'exit' ||
        reply.status === 'idle' ||
        reply.status === 'done'
      );
    },
    // Work besides the idle agent: any foreground program that is neither the
    // agent nor a shell, or an agent with a live child shell. A terminal hc
    // cannot show is not held.
    busy(session) {
      const foreground = record(liveTerminal(session)?.foreground);
      const name = text(foreground?.name);
      if (!name || isShell(name)) return false;
      if (name !== claudeAgent) return true;
      const pid = foreground?.pid;
      return typeof pid === 'number' && hasChildShell(pid);
    },
    list() {
      const terminals = listing();
      if (!Array.isArray(terminals)) return terminals;
      return terminals.flatMap((summary) => {
        const address = text(summary.address);
        if (!address || summary.state !== 'live') return [];
        const label = record(record(liveTerminal(address)?.labels))?.[
          TAB_LABEL
        ];
        return [
          {
            tab: address as TabRef,
            ...(typeof label === 'string' ? { label } : {}),
            scope: SCOPE,
            ...(typeof summary.status === 'string'
              ? { status: summary.status }
              : {}),
            sessions: () => [address as SessionRef],
          },
        ];
      });
    },
    // Killing a terminal also removes its tab from the window.
    close: (session) => outcome(run('hc', ['kill', session])),
    closeTab: (tab) => outcome(run('hc', ['kill', tab])),
    rename: (tab, label) =>
      outcome(run('hc', ['label', tab, `${TAB_LABEL}=${label}`])),
  };
}
