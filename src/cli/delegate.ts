import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  CodexHost,
  type CodexSessionResult,
  type CodexStartInput,
} from '../hosts/codex.ts';

const maxBriefs = 8;
const maxInputs = 16;
const maxBriefBytes = 8192;
const maxInputBytes = 2 * 1024 * 1024;
const maxTotalInputBytes = 8 * 1024 * 1024;
const minTimeoutMs = 1000;
const maxTimeoutMs = 30 * 60 * 1000;
const maxConcurrency = 4;

export type DelegateStatus = 'completed' | 'failed' | 'cancelled' | 'timeout';

export type DelegateWorkerResult = {
  readonly id: string;
  readonly brief: string;
  readonly status: DelegateStatus;
  readonly resultFile: string;
  readonly finalText?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly errorType?: string;
};

export type DelegateGroupResult = {
  readonly kind: 'delegate_group';
  readonly resultsDirectory: string;
  readonly workers: readonly DelegateWorkerResult[];
};

type ParsedRequest = {
  readonly repo: string;
  readonly inputs: readonly string[];
  readonly briefs: readonly string[];
  readonly results: string;
  readonly timeoutMs: number;
  readonly concurrency: number;
};

type DelegateSession = {
  readonly id: string;
  wait(): Promise<CodexSessionResult>;
};

type DelegateHost = {
  start(input: CodexStartInput): Promise<DelegateSession>;
  cancelTree(sessionId: string): Promise<void>;
};

export type DelegateRuntime = {
  readonly host?: DelegateHost;
  readonly signal?: AbortSignal;
  readonly write?: (text: string) => void;
  readonly setExitCode?: (code: number) => void;
};

function parseRequest(args: string[]): ParsedRequest {
  const singles = new Map<string, string>();
  const inputs: string[] = [];
  const briefs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === '--input') inputs.push(value);
    else if (flag === '--brief') briefs.push(value);
    else if (
      flag === '--repo' ||
      flag === '--results' ||
      flag === '--timeout-ms' ||
      flag === '--concurrency'
    ) {
      if (singles.has(flag)) throw new Error(`duplicate ${flag}`);
      singles.set(flag, value);
    } else throw new Error(`unknown delegate option ${flag}`);
  }

  const repoArg = singles.get('--repo');
  const resultsArg = singles.get('--results');
  const timeoutText = singles.get('--timeout-ms');
  const concurrencyText = singles.get('--concurrency');
  if (!repoArg || !isAbsolute(repoArg))
    throw new Error('--repo must be an absolute path');
  if (!resultsArg || !isAbsolute(resultsArg))
    throw new Error('--results must be an absolute path');
  if (inputs.length === 0 || inputs.length > maxInputs)
    throw new Error(`--input must be supplied 1 to ${maxInputs} times`);
  if (briefs.length === 0 || briefs.length > maxBriefs)
    throw new Error(`--brief must be supplied 1 to ${maxBriefs} times`);
  for (const brief of briefs) {
    if (!brief.trim() || Buffer.byteLength(brief) > maxBriefBytes)
      throw new Error(`each --brief must contain 1 to ${maxBriefBytes} bytes`);
  }
  const timeoutMs = Number(timeoutText);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < minTimeoutMs ||
    timeoutMs > maxTimeoutMs
  )
    throw new Error(
      `--timeout-ms must be between ${minTimeoutMs} and ${maxTimeoutMs}`,
    );
  const concurrency = Number(concurrencyText);
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > maxConcurrency ||
    concurrency > briefs.length
  )
    throw new Error(
      `--concurrency must be between 1 and min(${maxConcurrency}, brief count)`,
    );

  return {
    repo: repoArg,
    inputs,
    briefs,
    results: resultsArg,
    timeoutMs,
    concurrency,
  };
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path.length > 0 &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
    },
  });
  if (result.status !== 0 || result.stderr)
    throw new Error('repository input validation failed');
  return result.stdout.trim();
}

async function validateRepo(request: ParsedRequest): Promise<{
  readonly repo: string;
  readonly inputs: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}> {
  const repo = await realpath(request.repo);
  if ((await realpath(git(repo, ['rev-parse', '--show-toplevel']))) !== repo)
    throw new Error('--repo must be the canonical repository root');
  let totalBytes = 0;
  const inputs: { path: string; content: string }[] = [];
  for (const input of request.inputs) {
    const candidate = resolve(repo, input);
    if (!inside(repo, candidate))
      throw new Error('--input must be inside --repo');
    const path = await realpath(candidate);
    if (!inside(repo, path))
      throw new Error('--input must resolve inside --repo');
    const pathFromRepo = relative(repo, path);
    const segments = pathFromRepo.split(sep);
    if (segments.some((part) => ['.git', '.krn', '.codex'].includes(part)))
      throw new Error('private repository state cannot be delegated');
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('--input must be a regular nonsymlink file');
    const tracked = spawnSync(
      'git',
      ['-C', repo, 'ls-files', '--error-unmatch', '--', pathFromRepo],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_LAZY_FETCH: '1',
        },
      },
    );
    if (tracked.status !== 0 || tracked.stderr)
      throw new Error('--input must be a tracked repository file');
    if (
      info.size > maxInputBytes ||
      totalBytes + info.size > maxTotalInputBytes
    )
      throw new Error('delegated inputs exceed the bounded size limit');
    const content = await readFile(path, 'utf8');
    if (content.includes('\0')) throw new Error('--input must be UTF-8 text');
    totalBytes += Buffer.byteLength(content);
    inputs.push({ path: pathFromRepo, content });
  }
  return { repo, inputs };
}

async function ensurePrivateResultsDirectory(
  repo: string,
  requested: string,
): Promise<string> {
  const base = join(repo, '.krn', 'tmp');
  if (!inside(base, requested))
    throw new Error('--results must be a new directory under <repo>/.krn/tmp');
  const ignored = spawnSync(
    'git',
    ['-C', repo, 'check-ignore', '-q', '.krn/tmp'],
    {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' },
    },
  );
  if (ignored.status !== 0) throw new Error('repository must ignore .krn/tmp');
  for (const directory of [join(repo, '.krn'), base]) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('delegation state path must contain real directories');
  }
  const destinationRelative = relative(base, requested);
  const parts = destinationRelative.split(sep);
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error(
      '--results must name a new subdirectory under <repo>/.krn/tmp',
    );
  let current = base;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (
        index === parts.length - 1 ||
        (error as NodeJS.ErrnoException).code !== 'EEXIST'
      )
        throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('delegation state path must contain real directories');
  }
  return requested;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, path);
}

function errorType(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name))
    return error.name;
  return 'WorkerError';
}

function promptFor(
  brief: string,
  inputs: readonly { readonly path: string }[],
): string {
  return [
    'Perform this bounded read-only research task. Read only the supplied files in the current directory. Do not write files, submit changes, access a board, publish, or delegate further.',
    `Brief:\n${brief}`,
    `Supplied input files:\n${inputs.map(({ path }) => `- inputs/${path}`).join('\n')}`,
    'Return the complete result as your final response. Do not claim completion without a result.',
  ].join('\n\n');
}

async function executeWorker(
  request: ParsedRequest,
  host: DelegateHost,
  signal: AbortSignal | undefined,
  resultsDirectory: string,
  index: number,
  inputFiles: readonly { readonly path: string; readonly content: string }[],
): Promise<DelegateWorkerResult> {
  const id = `worker-${index + 1}`;
  const resultFile = join(resultsDirectory, `${id}.json`);
  const brief = request.briefs[index];
  if (brief === undefined) throw new Error('delegate worker brief is missing');
  const workspace = join(resultsDirectory, 'workspace', id);
  let timedOut = false;
  let sessionId: string | undefined;
  let cancelPromise: Promise<void> | undefined;
  let cancelFailure: unknown;
  const cancel = () => {
    if (!sessionId) return;
    cancelPromise ??= host.cancelTree(sessionId).catch((error: unknown) => {
      cancelFailure = error;
    });
  };
  if (signal?.aborted) return { id, brief, status: 'cancelled', resultFile };

  const timeout = setTimeout(() => {
    timedOut = true;
    cancel();
  }, request.timeoutMs);
  timeout.unref();
  signal?.addEventListener('abort', cancel);
  try {
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    for (const input of inputFiles) {
      const staged = join(workspace, 'inputs', input.path);
      await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
      await writeFile(staged, input.content, {
        encoding: 'utf8',
        mode: 0o400,
        flag: 'wx',
      });
    }
    const session = await host.start({
      cwd: workspace,
      model: 'gpt-6-luna',
      reasoningEffort: 'high',
      disableProjectDocs: true,
      sandbox: 'read-only',
      prompt: promptFor(brief, inputFiles),
      limits: { timeoutMs: request.timeoutMs },
    });
    sessionId = session.id;
    if (signal?.aborted || timedOut) cancel();
    const result = await session.wait();
    await cancelPromise;
    if (cancelFailure) {
      return {
        id,
        brief,
        status: 'failed',
        resultFile,
        errorType: errorType(cancelFailure),
      };
    }
    const finalText = result.finalMessage;
    if (timedOut)
      return {
        id,
        brief,
        status: 'timeout',
        resultFile,
        ...(finalText === undefined ? {} : { finalText }),
        exitCode: result.exitCode,
        signal: result.signal,
      };
    if (signal?.aborted)
      return {
        id,
        brief,
        status: 'cancelled',
        resultFile,
        ...(finalText === undefined ? {} : { finalText }),
        exitCode: result.exitCode,
        signal: result.signal,
      };
    if (result.exitCode !== 0 || !result.claimsDone || !finalText?.trim())
      return {
        id,
        brief,
        status: 'failed',
        resultFile,
        ...(finalText === undefined ? {} : { finalText }),
        exitCode: result.exitCode,
        signal: result.signal,
      };
    return {
      id,
      brief,
      status: 'completed',
      resultFile,
      finalText,
      exitCode: result.exitCode,
      signal: result.signal,
    };
  } catch (error) {
    await cancelPromise;
    if (cancelFailure)
      return {
        id,
        brief,
        status: 'failed',
        resultFile,
        errorType: errorType(cancelFailure),
      };
    if (timedOut)
      return {
        id,
        brief,
        status: 'timeout',
        resultFile,
        errorType: errorType(error),
      };
    if (signal?.aborted)
      return {
        id,
        brief,
        status: 'cancelled',
        resultFile,
        errorType: errorType(error),
      };
    return {
      id,
      brief,
      status: 'failed',
      resultFile,
      errorType: errorType(error),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function delegateCommand(
  args: string[],
  runtime: DelegateRuntime = {},
): Promise<DelegateGroupResult> {
  const request = parseRequest(args);
  const validated = await validateRepo(request);
  const resultsDirectory = await ensurePrivateResultsDirectory(
    validated.repo,
    request.results,
  );
  const host = runtime.host ?? new CodexHost();
  let nextIndex = 0;
  const workers: DelegateWorkerResult[] = new Array(request.briefs.length);
  const runSlot = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= request.briefs.length) return;
      const result = await executeWorker(
        request,
        host,
        runtime.signal,
        resultsDirectory,
        index,
        validated.inputs,
      );
      try {
        await atomicJson(result.resultFile, result);
        workers[index] = result;
      } catch (error) {
        workers[index] = {
          ...result,
          status: 'failed',
          errorType: errorType(error),
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: request.concurrency }, () => runSlot()),
  );
  const group: DelegateGroupResult = {
    kind: 'delegate_group',
    resultsDirectory,
    workers,
  };
  let groupWriteFailed = false;
  try {
    await atomicJson(join(resultsDirectory, 'group.json'), group);
  } catch {
    // The stdout result remains truthful about the failed worker files or group manifest.
    groupWriteFailed = true;
  }
  (runtime.write ?? ((text) => process.stdout.write(text)))(
    `${JSON.stringify(group)}\n`,
  );
  const exitCode =
    groupWriteFailed || workers.some((worker) => worker.status === 'failed')
      ? 1
      : workers.some((worker) => worker.status === 'timeout')
        ? 124
        : workers.some((worker) => worker.status === 'cancelled')
          ? 130
          : 0;
  runtime.setExitCode?.(exitCode);
  return group;
}
