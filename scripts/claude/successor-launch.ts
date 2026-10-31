import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
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
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
