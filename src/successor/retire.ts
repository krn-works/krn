// Retire predecessors.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { claudeAgent } from '../harness/claude.ts';
import { readJson } from '../repo/json-text.ts';
import { record, sleep, text } from './command.ts';
import { type SuccessorLaunchOptions, waitSeconds } from './options.ts';
import {
  isFailure,
  type ScopeRef,
  type SessionRef,
  selectHost,
  type TabRef,
  type TerminalHost,
} from './terminal-host.ts';

// Retire: close the predecessor panes that finished, rewrite the launch ledger and rename the caller's tab.

type LaunchRecord = {
  pane_id: string;
  tab_id: string;
  session_id: string;
  name: string;
  recorded_at: string;
};

function keptRunning(host: TerminalHost, session: SessionRef): boolean {
  if (!host.busy(session)) return false;
  process.stderr.write(`retire: kept ${session}: running work\n`);
  return true;
}

function runningSessionInTab(
  host: TerminalHost,
  scope: ScopeRef,
  tab: TabRef,
): SessionRef | undefined {
  const tabs = host.list(scope);
  if (isFailure(tabs)) return undefined;
  for (const listed of tabs)
    if (listed.tab === tab)
      for (const session of listed.sessions() ?? [])
        if (keptRunning(host, session)) return session;
  return undefined;
}

export function retireMode(
  args: string[],
  pause: (seconds: number) => void = sleep,
  now: () => number = Date.now,
  host: TerminalHost = selectHost(),
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
  const ownPane = host.self();
  if (!ownPane) {
    process.stderr.write('retire: skipped: not in Herdr\n');
    return 0;
  }
  const own = host.place(ownPane);
  if (!own.scope || !own.tab) {
    process.stderr.write('retire: failed: own pane unavailable\n');
    return 0;
  }
  const predId = process.env.KRN_PREDECESSOR_PANE;
  const predSession = process.env.KRN_PREDECESSOR_SESSION;
  if (predId && predSession) {
    const predPane = host.session(predId);
    const deadline = now() + wait * 1000;
    for (;;) {
      const info = host.agent(predPane);
      if (info.notFound || (info.sessionId && info.sessionId !== predSession))
        break;
      const settled = info.status === 'idle' || info.status === 'done';
      if (
        info.agent === claudeAgent &&
        info.sessionId === predSession &&
        settled
      ) {
        if (keptRunning(host, predPane)) break;
        const closed = host.close(predPane) === undefined;
        process.stderr.write(
          `retire: ${closed ? 'closed' : 'failed to close'} predecessor ${predPane}\n`,
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
      if (settled || !host.wait(predPane, remaining))
        pause(Math.min(5, remaining / 1000));
    }
  }
  const ledgerPath = join(cwd, '.krn', 'successors', 'launches.jsonl');
  try {
    rewriteLedger(
      ledgerPath,
      retireLedger(host, readLaunches(ledgerPath), ownPane),
    );
  } catch {
    process.stderr.write('retire: failed: ledger unavailable\n');
  }
  const tabs = host.list(own.scope);
  if (isFailure(tabs))
    process.stderr.write('retire: failed: malformed tab list\n');
  for (const tab of isFailure(tabs) ? [] : tabs) {
    const eligible =
      tab.label?.startsWith('handed off → ') === true &&
      tab.scope === own.scope &&
      tab.tab !== own.tab &&
      (tab.status === 'idle' || tab.status === 'done');
    if (eligible && runningSessionInTab(host, own.scope, tab.tab))
      process.stderr.write(`retire: kept tab ${tab.tab}\n`);
    else if (eligible)
      process.stderr.write(
        `retire: ${host.closeTab(tab.tab) === undefined ? 'closed' : 'kept'} tab ${tab.tab}\n`,
      );
    else process.stderr.write(`retire: kept tab ${tab.tab}\n`);
  }
  return 0;
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
    const value = record(readJson(line));
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
  }
  return launches;
}

function retireLedger(
  host: TerminalHost,
  launches: LaunchRecord[],
  callerPaneId: string,
): LaunchRecord[] {
  const kept: LaunchRecord[] = [];
  for (const launch of launches) {
    if (launch.pane_id === callerPaneId) continue;
    const pane = host.session(launch.pane_id);
    const info = host.agent(pane);
    if (info.notFound) continue;
    if (info.sessionId && info.sessionId !== launch.session_id) continue;
    if (
      info.agent === claudeAgent &&
      info.sessionId === launch.session_id &&
      (info.status === 'idle' || info.status === 'done')
    ) {
      if (keptRunning(host, pane)) {
        kept.push(launch);
        continue;
      }
      if (host.close(pane) === undefined) {
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

export function retirePredecessors(
  options: SuccessorLaunchOptions,
  callerPaneId: string,
  host: TerminalHost = selectHost(),
): void {
  const caller = host.agent(host.session(callerPaneId));
  if (
    caller.agent !== claudeAgent ||
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

  const kept = retireLedger(host, launches, callerPaneId);

  if (host.rename(caller.tabId, `handed off → ${options.name}`))
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
