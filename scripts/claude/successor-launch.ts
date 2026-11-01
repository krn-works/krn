import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SuccessorLaunchOptions {
  name: string;
  prompt: string;
  cwd: string;
}

type CommandResult = {
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

type AgentInfo = {
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
  const seen = new Set<string>();
  const flags = new Set(['--name', '--prompt', '--cwd']);

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
    else cwd = resolve(defaultCwd, value);
  }

  if (!name) throw new Error('required argument missing: --name');
  if (!prompt) throw new Error('required argument missing: --prompt');
  return { name, prompt, cwd };
}

function run(
  command: string,
  args: string[],
  cwd = process.cwd(),
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
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

function agentInfo(output: string): AgentInfo {
  try {
    const root = record(JSON.parse(output));
    const error = record(root?.error);
    if (error?.code === 'agent_not_found') return { notFound: true };

    const payload = record(root?.result);
    const agent = record(payload?.agent);
    const session = record(agent?.agent_session);
    return {
      agent: text(agent?.agent),
      status: text(agent?.agent_status),
      sessionId: text(session?.value),
      tabId: text(agent?.tab_id),
    };
  } catch {
    return {};
  }
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

function retirePredecessors(
  options: SuccessorLaunchOptions,
  callerPaneId: string,
): void {
  const callerResult = run('herdr', ['agent', 'get', callerPaneId]);
  const caller =
    callerResult.status === 0 && !callerResult.error
      ? agentInfo(callerResult.stdout)
      : {};
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

  const kept: LaunchRecord[] = [];
  for (const launch of launches) {
    if (launch.pane_id === callerPaneId) continue;

    const result = run('herdr', ['agent', 'get', launch.pane_id]);
    const info = agentInfo(result.stdout);
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

function createdIds(
  output: string,
): { tabId: string; paneId: string } | undefined {
  try {
    const root = record(JSON.parse(output));
    const payload = record(root?.result);
    const tab = record(payload?.tab);
    const pane = record(payload?.root_pane);
    const tabId = text(tab?.tab_id);
    const paneId = text(pane?.pane_id);
    return tabId && paneId ? { tabId, paneId } : undefined;
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

export function main(args: string[]): number {
  let options: SuccessorLaunchOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'invalid arguments'}\n`,
    );
    return 2;
  }

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

  const agent = process.env.KRN_SUCCESSOR_AGENT || 'claude';
  if (unavailable) {
    const fallback = run(
      agent,
      ['--bg', '-n', options.name, options.prompt],
      options.cwd,
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
    `KRN_SUCCESSOR_PROMPT=${options.prompt}`,
    '--no-focus',
  );
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
    '-n',
    '"$KRN_SUCCESSOR_NAME"',
    '"$KRN_SUCCESSOR_PROMPT"',
  ]);
  if (started.error || started.status !== 0) return exitFailure(started);

  process.stdout.write(
    `successor: herdr tab ${ids.tabId} pane ${ids.paneId}\n`,
  );
  if (paneId) retirePredecessors(options, paneId);
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
