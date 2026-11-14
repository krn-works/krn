// Retire predecessors.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  agentInfo,
  keptRunning,
  paneInfo,
  record,
  run,
  runningPaneInTab,
  sleep,
  text,
  waitUntilSettled,
} from './herdr.ts';
import { type SuccessorLaunchOptions, waitSeconds } from './options.ts';

// Retire: close the predecessor panes that finished, rewrite the launch ledger and rename the caller's tab.

type LaunchRecord = {
  pane_id: string;
  tab_id: string;
  session_id: string;
  name: string;
  recorded_at: string;
};

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
        if (keptRunning(predPane)) break;
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
      if (eligible && runningPaneInTab(own.workspaceId, id))
        process.stderr.write(`retire: kept tab ${id}\n`);
      else if (eligible) {
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
      if (keptRunning(launch.pane_id)) {
        kept.push(launch);
        continue;
      }
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

export function retirePredecessors(
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
