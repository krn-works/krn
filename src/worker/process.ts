import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { isMissing, type Session, WorkerError } from './state.ts';

export function workerUnit(run: string): string {
  return `krn-worker-${createHash('sha256').update(realpathSync(run)).digest('hex')}.scope`;
}

// proc files report size zero. Bound the actual read, including cmdline, to 64 KB.
function procText(pid: number, name: string): string {
  const fd = openSync(`/proc/${pid}/${name}`, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let size = 0;
    for (;;) {
      const length = readSync(fd, buffer, size, buffer.length - size, null);
      size += length;
      if (size === buffer.length)
        throw new WorkerError(65, `worker identity ${name} exceeds 64 KB`);
      if (!length) return buffer.subarray(0, size).toString('utf8');
    }
  } finally {
    closeSync(fd);
  }
}

export function parseProcessStat(text: string) {
  // proc(5): comm is parenthesized and may itself contain spaces and ')'.
  const end = text.lastIndexOf(')');
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const group = Number(fields[2]);
  const startTime = fields[19];
  if (
    end < 0 ||
    !fields[0] ||
    !Number.isSafeInteger(group) ||
    group <= 1 ||
    !startTime ||
    !/^\d+$/.test(startTime)
  )
    throw new WorkerError(65, 'invalid worker identity stat');
  return { state: fields[0], group, startTime };
}

export function processStat(pid: number) {
  try {
    return parseProcessStat(procText(pid, 'stat'));
  } catch (error) {
    if (isMissing(error) || isMissing(error, 'ESRCH')) return undefined;
    throw error;
  }
}

export function executablePath(executable: string): string {
  for (const candidate of executable.includes('/')
    ? [executable]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .map((path) => join(path, executable))) {
    try {
      return realpathSync(candidate);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new WorkerError(65, 'worker executable identity missing');
}

function serverCommand(pid: number, executable: string): boolean {
  const args = procText(pid, 'cmdline').split('\0');
  if (args.pop() !== '') return false;
  // The configured executable can also be a Node shebang script (test adapter).
  const command =
    args.length === 5 &&
    args[0] &&
    executablePath(args[0]) === realpathSync(process.execPath)
      ? args.slice(1)
      : args;
  return (
    command.length === 4 &&
    command[0] === executable &&
    command[1] === 'app-server' &&
    command[2] === '--listen' &&
    command[3] === 'stdio://'
  );
}

export function assertServerIdentity(
  state: Pick<
    Session,
    | 'unit'
    | 'serverPid'
    | 'serverStartTime'
    | 'serverExecutable'
    | 'serverGroup'
  >,
  run: string,
  allowMissing = false,
): boolean {
  if (state.unit !== workerUnit(run))
    throw new WorkerError(65, 'worker unit identity mismatch');
  const stat = processStat(state.serverPid);
  if (!stat || stat.state === 'Z') {
    if (allowMissing) return false;
    throw new WorkerError(
      65,
      `worker pid identity missing: ${state.serverPid} (${stat?.state ?? 'absent'})`,
    );
  }
  if (stat.startTime !== state.serverStartTime)
    throw new WorkerError(65, 'worker pid start time mismatch');
  if (stat.group !== state.serverGroup)
    throw new WorkerError(65, 'worker process group identity mismatch');
  let matches: boolean;
  try {
    matches = serverCommand(state.serverPid, state.serverExecutable);
  } catch (error) {
    const current = processStat(state.serverPid);
    if (allowMissing && (!current || current.state === 'Z')) return false;
    if (error instanceof WorkerError) throw error;
    throw new WorkerError(65, 'worker cmdline identity unavailable');
  }
  // Re-read stat after cmdline so exec/exit/reuse during observation fails closed.
  const after = processStat(state.serverPid);
  if (allowMissing && (!after || after.state === 'Z')) return false;
  if (after?.startTime !== state.serverStartTime)
    throw new WorkerError(65, 'worker pid start time changed');
  if (!matches) throw new WorkerError(65, 'worker cmdline identity mismatch');
  return true;
}

export function findServerIdentity(launcherPid: number, executable: string) {
  const pending = [launcherPid];
  const visited = new Set<number>();
  while (pending.length) {
    const pid = pending.shift();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);
    if (visited.size > 1024)
      throw new WorkerError(65, 'worker process identity tree exceeds 1024');
    const stat = processStat(pid);
    if (!stat || stat.state === 'Z') continue;
    if (serverCommand(pid, executable))
      return {
        serverPid: pid,
        serverStartTime: stat.startTime,
        serverGroup: stat.group,
        serverExecutable: executable,
      };
    for (const child of procText(pid, `task/${pid}/children`)
      .trim()
      .split(/\s+/)
      .filter(Boolean)) {
      if (!/^\d+$/.test(child))
        throw new WorkerError(65, 'invalid worker child identity');
      pending.push(Number(child));
    }
  }
  return undefined;
}

export function assertDriverIdentity(
  state: Session,
  run: string,
  allowMissing = false,
): boolean {
  const stat = processStat(state.pid);
  if (!stat || stat.state === 'Z') {
    if (allowMissing) return false;
    throw new WorkerError(65, 'worker driver identity missing');
  }
  let command: string[];
  try {
    command = procText(state.pid, 'cmdline').split('\0');
  } catch {
    const current = processStat(state.pid);
    if (allowMissing && (!current || current.state === 'Z')) return false;
    throw new WorkerError(65, 'worker driver cmdline identity unavailable');
  }
  const after = processStat(state.pid);
  if (allowMissing && (!after || after.state === 'Z')) return false;
  if (
    stat.startTime !== state.pidStartTime ||
    command.length !== 4 ||
    command[0] !== process.execPath ||
    command[1] !== new URL('./driver.ts', import.meta.url).pathname ||
    command[2] !== run ||
    command[3] !== ''
  )
    throw new WorkerError(65, 'worker driver identity mismatch');
  if (after?.startTime !== state.pidStartTime)
    throw new WorkerError(65, 'worker driver start time changed');
  return true;
}
