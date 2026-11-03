import { closeSync, createReadStream, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  LocalReadError,
  listVerifiedDirectory,
  lstatVerified,
  lstatVerifiedIfPresent,
  openVerifiedDirectory,
  openVerifiedFile,
  readBoundedFile,
} from '../src/fs/local-read.ts';

const maxRolloutBytes = 1024 ** 3;
const maxJsonBytes = 1024 ** 2;
const maxDirectoryEntries = 10_000;
const maxVisitedEntries = 100_000;
const maxRoundEntries = 1_000;
const maxInputs = 64;
const maxSearchDepth = 4;
const usageKeys = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
] as const;

type Source = 'rollout' | 'thread' | 'run';
type Input = { source: Source; value: string };
type Usage = Record<(typeof usageKeys)[number], number>;
type RolloutReport = {
  source: Source;
  rolloutId: string;
  file: string;
  models: string[];
  efforts: string[];
  firstTs: string;
  lastTs: string;
  wallMinutes: number;
  calls: number;
  input: number;
  cached: number;
  output: number;
  uncached: number;
  peakContext: number;
  malformedLines: number;
  driverUncached: number | null;
};

class ReportFailure extends Error {
  readonly exitCode: 64 | 65 | 70;
  readonly input: string;

  constructor(exitCode: 64 | 65 | 70, input: string, message: string) {
    super(message);
    this.exitCode = exitCode;
    this.input = input;
  }
}

function fail(
  input: string,
  message = 'invalid data',
  exitCode: 65 | 70 = 65,
): never {
  throw new ReportFailure(exitCode, input, message);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function usage(value: unknown): Usage | undefined {
  if (!record(value)) return undefined;
  const result = {} as Usage;
  for (const key of usageKeys) {
    if (!safeCount(value[key])) return undefined;
    result[key] = value[key];
  }
  if (
    result.cached_input_tokens > result.input_tokens ||
    !Number.isSafeInteger(
      result.input_tokens - result.cached_input_tokens + result.output_tokens,
    )
  )
    return undefined;
  return result;
}

function normalizedUuid(value: string): string | undefined {
  if (
    !/^(?:[a-f\d]{8,32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/iu.test(
      value,
    )
  )
    return undefined;
  return value.replaceAll('-', '').toLowerCase();
}

function clipped(value: string): string {
  return value.slice(0, 64);
}

function addDistinct(values: string[], value: string): void {
  const clippedValue = clipped(value);
  if (values.length < 16 && !values.includes(clippedValue))
    values.push(clippedValue);
}

function sanitized(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? '?' : character;
    })
    .join('')
    .slice(0, 256);
}

function localRead<T>(input: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof LocalReadError)) throw error;
    fail(
      input,
      error.reason === 'entry-limit'
        ? 'directory entry limit exceeded'
        : undefined,
    );
  }
}

function lstatPath(path: string, input: string) {
  return localRead(input, () => lstatVerified(path));
}

function maybeLstat(path: string, input: string) {
  return localRead(input, () => lstatVerifiedIfPresent(path));
}

function openRegularFile(path: string, limit: number, input: string) {
  return localRead(input, () => openVerifiedFile(path, limit));
}

function readSmallJson(path: string, input: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      localRead(input, () => readBoundedFile(path, maxJsonBytes)).toString(
        'utf8',
      ),
    );
    if (!record(parsed)) fail(input);
    return parsed;
  } catch (error) {
    if (error instanceof ReportFailure) throw error;
    fail(input);
  }
}

function parseArgs(args: string[]): {
  inputs: Input[];
  sessions: string;
} {
  const inputs: Input[] = [];
  let sessions = join(homedir(), '.codex', 'sessions');
  let sessionsSeen = false;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === '--sessions') {
      const value = args[index + 1];
      if (!value || value.startsWith('--'))
        throw new ReportFailure(64, option, 'missing value');
      if (sessionsSeen) throw new ReportFailure(64, option, 'duplicate option');
      sessionsSeen = true;
      sessions = value;
      index++;
      continue;
    }
    if (option === '--rollout' || option === '--thread' || option === '--run') {
      const value = args[index + 1];
      if (!value || value.startsWith('--'))
        throw new ReportFailure(64, option, 'missing value');
      const source = option.slice(2) as Source;
      if (source === 'thread' && normalizedUuid(value) === undefined)
        throw new ReportFailure(64, `${option} ${value}`, 'invalid thread id');
      inputs.push({ source, value });
      if (inputs.length > maxInputs)
        throw new ReportFailure(64, option, 'too many inputs');
      index++;
      continue;
    }
    throw new ReportFailure(64, option ?? '<arguments>', 'unknown argument');
  }
  if (!inputs.length) throw new ReportFailure(64, '<arguments>', 'no input');
  return { inputs, sessions: resolve(sessions) };
}

function tokenUsageInfo(
  value: unknown,
): { total: Usage; last: Usage } | null | undefined {
  if (value === null) return null;
  if (!record(value)) return undefined;
  const total = usage(value.total_token_usage);
  const last = usage(value.last_token_usage);
  if (!total || !last) return undefined;
  return { total, last };
}

async function readRollout(
  path: string,
  source: Source,
  inputName: string,
  expectedUuid?: string,
): Promise<RolloutReport> {
  const { fd, size } = openRegularFile(path, maxRolloutBytes, inputName);
  const models: string[] = [];
  const efforts: string[] = [];
  let rolloutId: string | undefined;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let previousTotal = 0;
  let totalUsage: Usage | undefined;
  let peakContext = 0;
  let calls = 0;
  let malformedLines = 0;
  let physicalLine = 0;
  let streamError = false;

  try {
    if (size > 0) {
      const stream = createReadStream(path, {
        fd,
        autoClose: false,
        encoding: 'utf8',
        start: 0,
        end: size - 1,
      });
      stream.on('error', () => {
        streamError = true;
      });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      for await (let line of lines) {
        physicalLine++;
        if (physicalLine === 1 && line.startsWith('\uFEFF'))
          line = line.slice(1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          malformedLines++;
          continue;
        }
        if (
          !record(parsed) ||
          typeof parsed.timestamp !== 'string' ||
          !Number.isFinite(Date.parse(parsed.timestamp)) ||
          typeof parsed.type !== 'string' ||
          !parsed.type ||
          !record(parsed.payload)
        ) {
          malformedLines++;
          continue;
        }

        const timestamp = new Date(parsed.timestamp).toISOString();
        const payload = parsed.payload;
        let metaId: string | undefined;
        let model: string | undefined;
        let effort: string | undefined;
        let info: { total: Usage; last: Usage } | null | undefined;

        if (parsed.type === 'session_meta') {
          if (typeof payload.id !== 'string' || !payload.id) {
            malformedLines++;
            continue;
          }
          metaId = payload.id;
          if (rolloutId !== undefined && rolloutId !== metaId) {
            malformedLines++;
            continue;
          }
        } else if (parsed.type === 'turn_context') {
          if (
            typeof payload.model !== 'string' ||
            typeof payload.effort !== 'string'
          ) {
            malformedLines++;
            continue;
          }
          model = payload.model;
          effort = payload.effort;
        } else if (
          parsed.type === 'event_msg' &&
          payload.type === 'token_count'
        ) {
          if (!Object.hasOwn(payload, 'info')) {
            malformedLines++;
            continue;
          }
          info = tokenUsageInfo(payload.info);
          if (info === undefined) {
            malformedLines++;
            continue;
          }
        }

        firstTs ??= timestamp;
        lastTs = timestamp;
        if (metaId !== undefined) rolloutId = metaId;
        if (model !== undefined) addDistinct(models, model);
        if (effort !== undefined) addDistinct(efforts, effort);
        if (info && info !== null) {
          const currentTotal = info.total.total_tokens;
          if (currentTotal !== previousTotal) calls++;
          previousTotal = currentTotal;
          totalUsage = info.total;
          peakContext = Math.max(peakContext, info.last.input_tokens);
        }
      }
      if (streamError) fail(inputName);
    }
  } catch (error) {
    if (error instanceof ReportFailure) throw error;
    fail(inputName);
  } finally {
    closeSync(fd);
  }

  if (!rolloutId || !firstTs || !lastTs || !totalUsage) fail(inputName);
  if (expectedUuid !== undefined) {
    const embedded = normalizedUuid(rolloutId);
    if (!embedded?.startsWith(expectedUuid)) fail(inputName);
  }
  const input = totalUsage.input_tokens;
  const cached = totalUsage.cached_input_tokens;
  const output = totalUsage.output_tokens;
  const uncached = input - cached + output;
  if (!Number.isSafeInteger(uncached)) fail(inputName);

  const elapsed = Date.parse(lastTs) - Date.parse(firstTs);
  return {
    source,
    rolloutId: clipped(rolloutId),
    file: path,
    models,
    efforts,
    firstTs,
    lastTs,
    wallMinutes: Math.round(elapsed / 6000) / 10,
    calls,
    input,
    cached,
    output,
    uncached,
    peakContext,
    malformedLines,
    driverUncached: null,
  };
}

function ensureDirectory(path: string, input: string) {
  return openDirectory(path, input);
}

function openDirectory(path: string, input: string): number {
  return localRead(input, () => openVerifiedDirectory(path));
}

function readDirectory(
  fd: number,
  input: string,
  limit = maxDirectoryEntries,
): Dirent[] {
  return localRead(input, () => listVerifiedDirectory(fd, limit));
}

function filenameUuid(name: string): string | undefined {
  const match =
    /^rollout-.*-([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\.jsonl$/iu.exec(
      name,
    );
  return match?.[1]?.replaceAll('-', '').toLowerCase();
}

function findThreadFile(
  sessions: string,
  threadId: string,
  inputName: string,
): string {
  const rootFd = ensureDirectory(sessions, inputName);
  const uuidPrefix = normalizedUuid(threadId) ?? fail(inputName);
  const matches: Array<{ path: string; uuid: string }> = [];
  let visited = 0;

  function walk(directory: string, depth: number): void {
    const dirFd =
      directory === sessions ? rootFd : openDirectory(directory, inputName);
    let entries: Dirent[];
    try {
      entries = readDirectory(dirFd, inputName);
    } finally {
      if (dirFd !== rootFd) closeSync(dirFd);
    }
    for (const entry of entries) {
      visited++;
      if (visited > maxVisitedEntries)
        fail(inputName, 'search entry limit exceeded');
      const path = join(directory, entry.name);
      const uuid = filenameUuid(entry.name);
      if (uuid?.startsWith(uuidPrefix)) {
        const stat = lstatPath(path, inputName);
        if (stat.isSymbolicLink() || !stat.isFile()) fail(inputName);
        matches.push({ path, uuid });
        if (matches.length >= 2) return;
        continue;
      }
      if (!entry.isDirectory() || depth + 1 >= maxSearchDepth) continue;
      const stat = lstatPath(path, inputName);
      if (stat.isSymbolicLink()) continue;
      if (!stat.isDirectory()) continue;
      walk(path, depth + 1);
      if (matches.length >= 2) return;
    }
  }

  try {
    walk(sessions, 0);
  } finally {
    closeSync(rootFd);
  }
  if (matches.length !== 1) fail(inputName);
  const match = matches[0];
  if (!match) fail(inputName);
  return match.path;
}

function runSession(runDir: string, inputName: string): string {
  const fd = ensureDirectory(runDir, inputName);
  closeSync(fd);
  const sessionPath = join(runDir, 'session.json');
  const closedPath = join(runDir, 'closed-session.json');
  const selected = maybeLstat(sessionPath, inputName)
    ? sessionPath
    : closedPath;
  const session = readSmallJson(selected, inputName);
  if (typeof session.threadId !== 'string' || !normalizedUuid(session.threadId))
    fail(inputName);
  return session.threadId;
}

function driverUncached(runDir: string, inputName: string): number | null {
  const roundsPath = join(runDir, 'rounds');
  const roundsStat = maybeLstat(roundsPath, inputName);
  if (!roundsStat) return null;
  if (roundsStat.isSymbolicLink() || !roundsStat.isDirectory()) fail(inputName);
  const roundsFd = openDirectory(roundsPath, inputName);
  let entries: Dirent[];
  try {
    entries = readDirectory(roundsFd, inputName, maxRoundEntries);
  } finally {
    closeSync(roundsFd);
  }
  let latest: { number: number; path: string } | undefined;
  for (const entry of entries) {
    if (!/^\d{3}$/u.test(entry.name)) continue;
    const roundPath = join(roundsPath, entry.name);
    const roundStat = lstatPath(roundPath, inputName);
    if (roundStat.isSymbolicLink() || !roundStat.isDirectory()) fail(inputName);
    const metricsPath = join(roundPath, 'metrics.json');
    const metricsStat = maybeLstat(metricsPath, inputName);
    if (!metricsStat) continue;
    if (
      metricsStat.isSymbolicLink() ||
      !metricsStat.isFile() ||
      metricsStat.size > maxJsonBytes
    )
      fail(inputName);
    const number = Number(entry.name);
    if (!latest || number > latest.number)
      latest = { number, path: metricsPath };
  }
  if (!latest) return null;
  const metrics = readSmallJson(latest.path, inputName);
  if (
    !record(metrics.cumulative) ||
    !safeCount(metrics.cumulative.uncached_total)
  )
    fail(inputName);
  return metrics.cumulative.uncached_total;
}

async function report(input: Input, sessions: string): Promise<RolloutReport> {
  const inputName = `--${input.source} ${input.value}`;
  if (input.source === 'rollout') {
    const path = resolve(input.value);
    return readRollout(path, input.source, inputName);
  }
  if (input.source === 'thread') {
    const path = findThreadFile(sessions, input.value, inputName);
    const uuid = normalizedUuid(input.value);
    const rollout = await readRollout(path, input.source, inputName, uuid);
    const filenameId = filenameUuid(basename(path));
    if (!filenameId?.startsWith(uuid ?? '')) fail(inputName);
    return rollout;
  }

  const runDir = resolve(input.value);
  const threadId = runSession(runDir, inputName);
  const path = findThreadFile(sessions, threadId, inputName);
  const uuid = normalizedUuid(threadId);
  const rollout = await readRollout(path, input.source, inputName, uuid);
  const filenameId = filenameUuid(basename(path));
  if (!filenameId || filenameId !== uuid) fail(inputName);
  rollout.driverUncached = driverUncached(runDir, inputName);
  return rollout;
}

async function main(): Promise<void> {
  let activeInput = '<arguments>';
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const reports: RolloutReport[] = [];
    for (const input of parsed.inputs) {
      activeInput = `--${input.source} ${input.value}`;
      reports.push(await report(input, parsed.sessions));
    }
    process.stdout.write(
      `${reports.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
  } catch (error) {
    const failure =
      error instanceof ReportFailure
        ? error
        : new ReportFailure(70, activeInput, 'internal error');
    process.stderr.write(
      `rollout-usage: ${failure.message} for ${sanitized(failure.input)}\n`,
    );
    process.exitCode = failure.exitCode;
  }
}

if (import.meta.main) await main();
