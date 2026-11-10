import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentInfo,
  type CommandResult,
  createdIds,
  paneInfo,
  run,
} from './successor-launch.ts';

/**
 * One command proves a successor-launch change against the live Herdr.
 * A scratch shell tab runs the launcher, never the caller's pane: a shell
 * caller has no agent, so the launcher skips the tab rename, the ledger and
 * the predecessor env that would hand off or close a lead pane. The successor
 * starts in an untrusted scratch cwd and holds on Claude's folder-trust
 * dialog, so it spends no tokens. Prints one verdict line, exits 0 only for
 * a launcher exit 0 and a successor Herdr shows as `claude blocked`, and
 * closes both tabs on every exit path, signals included.
 */

// Fixed labels mark the probe's tabs. The cleanup sweeps every tab carrying
// one in the workspace, so a probe killed before its cleanup leaves tabs the
// next run closes; two probes in one workspace close each other's tabs.
export const SHELL_LABEL = 'successor-probe-shell';
export const SUCCESSOR_LABEL = 'successor-probe';

const LAUNCHER = fileURLToPath(
  new URL('./successor-launch.ts', import.meta.url),
);
// A blocked successor shows within seconds (6 s in the t-g1cwxm2 probe).
const START_SECONDS = 30;
const MARGIN_SECONDS = 30;
const POLL_MS = 250;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
// Read only if the scratch cwd turns out trusted; the cheapest model answers.
const PROMPT =
  'Launcher probe: run nothing and stop; this tab closes in seconds.';

export type ProbeOptions = { startSeconds: number; waitSeconds: number };

type Ids = { tabId: string; paneId: string };

type Probe = {
  dir: string;
  caller: { workspaceId?: string; tabId?: string };
  shell?: Ids & { workspaceId?: string };
  exit?: number;
  successor?: Ids;
  agent: string;
  problems: string[];
  closed: string[];
};

function seconds(value: string | undefined): number | undefined {
  return value !== undefined &&
    /^(0|[1-9]\d*)$/u.test(value) &&
    Number(value) <= 600
    ? Number(value)
    : undefined;
}

export function parseArgs(args: string[]): ProbeOptions {
  let start: number | undefined;
  let wait: number | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? '';
    const value = seconds(args[index + 1]);
    if (
      flag === '--start-seconds' &&
      start === undefined &&
      value !== undefined
    )
      start = value;
    else if (
      flag === '--wait-seconds' &&
      wait === undefined &&
      value !== undefined
    )
      wait = value;
    else
      throw new Error(
        `invalid argument: ${flag} (usage: successor-probe.ts [--start-seconds 0-600] [--wait-seconds 0-600])`,
      );
  }
  const startSeconds = start ?? START_SECONDS;
  return { startSeconds, waitSeconds: wait ?? startSeconds + MARGIN_SECONDS };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ok(result: CommandResult): boolean {
  return result.status === 0 && !result.error;
}

// Herdr prints a server error as JSON on stderr with exit 1; name its code.
function failure(result: CommandResult): string {
  if (result.error)
    return result.error.message.includes('ENOENT')
      ? 'herdr not on PATH'
      : result.error.message;
  try {
    const code = record(record(JSON.parse(result.stderr))?.error)?.code;
    if (typeof code === 'string') return code;
  } catch {}
  return result.stderr.trim() || `exit ${result.status}`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// `herdr pane run` types its words into the pane's shell, so the launcher
// runs from a POSIX script whatever shell the pane hosts, and writes its
// streams and exit status to files the probe reads.
function launchScript(dir: string, options: ProbeOptions): string {
  const launch = [
    'KRN_SUCCESSOR_AGENT=claude',
    quote(process.execPath),
    quote(LAUNCHER),
    '--operator-token',
    '--name',
    SUCCESSOR_LABEL,
    '--prompt',
    quote(PROMPT),
    '--cwd',
    quote(dir),
    '--class',
    'non-delivery',
    '--model',
    'haiku',
    '--start-seconds',
    String(options.startSeconds),
    `>${quote(join(dir, 'launcher.stdout'))}`,
    `2>${quote(join(dir, 'launcher.stderr'))}`,
  ].join(' ');
  return `${launch}\nprintf '%s\\n' "$?" >${quote(join(dir, 'launcher.exit'))}\n`;
}

// One printf writes the status after the launcher exits, so a status
// without its newline is still being written.
function launcherExit(dir: string): number | undefined {
  const status = readText(join(dir, 'launcher.exit'));
  return /^\d+\n$/u.test(status) ? Number(status.trim()) : undefined;
}

function successorOf(stdout: string): Ids | undefined {
  const match = /^successor: herdr tab (\S+) pane (\S+) agent \S+ \S+$/mu.exec(
    stdout,
  );
  return match?.[1] && match[2]
    ? { tabId: match[1], paneId: match[2] }
    : undefined;
}

function labelledTabs(output: string): Map<string, string> | undefined {
  try {
    const tabs = record(record(JSON.parse(output))?.result)?.tabs;
    if (!Array.isArray(tabs)) return undefined;
    const found = new Map<string, string>();
    for (const value of tabs) {
      const tab = record(value);
      const id = tab?.tab_id;
      const label = tab?.label;
      if (
        typeof id === 'string' &&
        (label === SHELL_LABEL || label === SUCCESSOR_LABEL)
      )
        found.set(id, label);
    }
    return found;
  } catch {
    return undefined;
  }
}

async function launch(
  probe: Probe,
  options: ProbeOptions,
  pause: (ms: number) => Promise<boolean>,
): Promise<void> {
  const created = run('herdr', [
    'tab',
    'create',
    ...(probe.caller.workspaceId
      ? ['--workspace', probe.caller.workspaceId]
      : []),
    '--cwd',
    probe.dir,
    '--label',
    SHELL_LABEL,
    '--no-focus',
  ]);
  const shell = ok(created) ? createdIds(created.stdout) : undefined;
  if (!shell) {
    probe.problems.push(`tab create failed: ${failure(created)}`);
    return;
  }
  probe.shell = shell;

  const script = join(probe.dir, 'launch.sh');
  writeFileSync(script, launchScript(probe.dir, options));
  const typed = run('herdr', [
    'pane',
    'run',
    shell.paneId,
    '/bin/sh',
    quote(script),
  ]);
  if (!ok(typed)) {
    probe.problems.push(`pane run failed: ${failure(typed)}`);
    return;
  }

  const deadline = Date.now() + options.waitSeconds * 1000;
  for (;;) {
    const exit = launcherExit(probe.dir);
    if (exit !== undefined) {
      probe.exit = exit;
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      probe.problems.push(
        `launcher did not finish in ${options.waitSeconds} s`,
      );
      return;
    }
    if (!(await pause(Math.min(POLL_MS, remaining)))) return;
  }
  if (probe.exit !== 0) probe.problems.push(`launcher exit ${probe.exit}`);

  const successor = successorOf(readText(join(probe.dir, 'launcher.stdout')));
  if (!successor) return;
  probe.successor = successor;
  const info = agentInfo(run('herdr', ['agent', 'get', successor.paneId]));
  probe.agent = info.agent
    ? `${info.agent} ${info.status ?? 'unknown'}`
    : 'none';
  if (probe.agent !== 'claude blocked')
    probe.problems.push(
      `successor agent ${probe.agent}, expected claude blocked`,
    );
}

// Closes the successor's tabs first, then the shell tabs: the ids the probe
// and the launcher reported, and every tab carrying a probe label in the
// workspace, never the caller's own tab.
function cleanup(probe: Probe, stderr: string): void {
  const successorTabs = new Set<string>();
  const shellTabs = new Set<string>();
  if (probe.successor) successorTabs.add(probe.successor.tabId);
  for (const match of stderr.matchAll(/\btab (\S+) kept for inspection/gu))
    if (match[1]) successorTabs.add(match[1]);
  if (probe.shell) shellTabs.add(probe.shell.tabId);

  const workspace = probe.shell?.workspaceId ?? probe.caller.workspaceId;
  if (workspace) {
    const list = run('herdr', ['tab', 'list', '--workspace', workspace]);
    const found = ok(list) ? labelledTabs(list.stdout) : undefined;
    if (!found) probe.problems.push(`tab list failed: ${failure(list)}`);
    else
      for (const [id, label] of found)
        (label === SUCCESSOR_LABEL ? successorTabs : shellTabs).add(id);
  }

  for (const id of new Set([...successorTabs, ...shellTabs])) {
    if (id === probe.caller.tabId) continue;
    const closed = run('herdr', ['tab', 'close', id]);
    if (ok(closed)) probe.closed.push(id);
    else probe.problems.push(`tab close failed: ${id} ${failure(closed)}`);
  }
}

export async function main(args: string[]): Promise<number> {
  let options: ProbeOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'invalid arguments'}\n`,
    );
    return 64;
  }

  // A signal ends the wait instead of the process, so the cleanup still runs.
  let interrupted: string | undefined;
  let wake: (() => void) | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    interrupted ??= signal;
    wake?.();
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  const pause = (ms: number): Promise<boolean> =>
    new Promise((done) => {
      const finish = (): void => {
        clearTimeout(timer);
        wake = undefined;
        done(interrupted === undefined);
      };
      const timer = setTimeout(finish, ms);
      wake = finish;
      if (interrupted) finish();
    });

  const callerPane = process.env.HERDR_PANE_ID;
  const callerReply = callerPane
    ? run('herdr', ['pane', 'get', callerPane])
    : undefined;
  const probe: Probe = {
    dir: mkdtempSync(join(tmpdir(), 'successor-probe-')),
    caller: callerReply && ok(callerReply) ? paneInfo(callerReply.stdout) : {},
    agent: 'none',
    problems: [],
    closed: [],
  };
  let stdout = '';
  let stderr = '';
  try {
    await launch(probe, options, pause);
  } catch (error) {
    probe.problems.push(
      `probe error: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    stdout = readText(join(probe.dir, 'launcher.stdout'));
    stderr = readText(join(probe.dir, 'launcher.stderr'));
    cleanup(probe, stderr);
    rmSync(probe.dir, { recursive: true, force: true });
    for (const signal of SIGNALS) process.off(signal, onSignal);
  }
  if (interrupted) probe.problems.push(`interrupted by ${interrupted}`);

  const verdict = probe.problems.length
    ? `FAIL (${probe.problems.join(', ')})`
    : 'PASS';
  process.stdout.write(
    `${[
      `successor-probe: ${verdict}`,
      `launcher exit ${probe.exit ?? 'none'}`,
      `stdout ${JSON.stringify(stdout.trimEnd())}`,
      `stderr ${JSON.stringify(stderr.trimEnd())}`,
      `agent ${probe.agent}`,
      `closed tabs ${probe.closed.join(' ') || 'none'}`,
    ].join('; ')}\n`,
  );
  return probe.problems.length ? 1 : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
