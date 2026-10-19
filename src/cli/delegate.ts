import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
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
const maxGitOutputBytes = 64 * 1024;
const gitCommandTimeoutMs = 5000;
const gitTerminateGraceMs = 250;
const inputReadChunkBytes = 64 * 1024;
const minTimeoutMs = 1000;
const maxTimeoutMs = 30 * 60 * 1000;
const maxConcurrency = 4;

export type DelegateStatus = 'completed' | 'failed' | 'cancelled' | 'timeout';

export type DelegateWorkerResult = {
  readonly id: string;
  readonly brief: string;
  readonly status: DelegateStatus;
  readonly resultFile?: string;
  readonly resultPersisted: boolean;
  readonly resultPersistenceErrorType?: string;
  readonly finalText?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly errorType?: string;
};

export type DelegateGroupResult = {
  readonly kind: 'delegate_group';
  readonly resultsDirectory: string;
  readonly workers: readonly DelegateWorkerResult[];
  readonly manifestPersisted: boolean;
  readonly manifestPersistenceErrorType?: string;
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

class GitCommandError extends Error {
  readonly kind: 'timeout' | 'aborted' | 'output_limit' | 'spawn';

  constructor(
    message: string,
    kind: 'timeout' | 'aborted' | 'output_limit' | 'spawn',
  ) {
    super(message);
    this.name = 'GitCommandError';
    this.kind = kind;
  }
}

type GitResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_LAZY_FETCH = '1';
  return env;
}

function signalGitTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined)
      process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function git(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<GitResult> {
  if (signal?.aborted)
    throw new GitCommandError('repository preflight interrupted', 'aborted');
  const child = spawn('git', ['-C', root, ...args], {
    detached: process.platform !== 'win32',
    env: gitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let failure: GitCommandError | undefined;
  let spawnFailure: Error | undefined;
  const closed = new Promise<{
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('close', (status, childSignal) =>
      resolve({ status, signal: childSignal }),
    );
  });
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      signalGitTree(child, 'SIGTERM');
      const stopped = await new Promise<boolean>((resolve) => {
        const grace = setTimeout(() => resolve(false), gitTerminateGraceMs);
        void closed.then(() => {
          clearTimeout(grace);
          resolve(true);
        });
      });
      if (!stopped) signalGitTree(child, 'SIGKILL');
      await closed;
    })();
    return stopPromise;
  };
  const onAbort = () => {
    failure ??= new GitCommandError(
      'repository preflight interrupted',
      'aborted',
    );
    void stop();
  };
  const timeout = setTimeout(() => {
    failure ??= new GitCommandError(
      'repository preflight Git command timed out',
      'timeout',
    );
    void stop();
  }, gitCommandTimeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  child.once('error', (error) => {
    spawnFailure = error;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > maxGitOutputBytes) {
      failure ??= new GitCommandError(
        'repository preflight Git output exceeded its limit',
        'output_limit',
      );
      void stop();
    } else stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > maxGitOutputBytes) {
      failure ??= new GitCommandError(
        'repository preflight Git output exceeded its limit',
        'output_limit',
      );
      void stop();
    } else stderr.push(chunk);
  });
  if (signal?.aborted) onAbort();
  const result = await closed;
  clearTimeout(timeout);
  signal?.removeEventListener('abort', onAbort);
  if (stopPromise) await stopPromise;
  if (failure) throw failure;
  if (spawnFailure)
    throw new GitCommandError(
      `unable to run repository preflight: ${spawnFailure.message}`,
      'spawn',
    );
  return {
    status: result.status,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

function sameFile(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function ensurePinnedPath(
  candidate: string,
  canonicalPath: string,
  repo: string,
  pinned: { readonly dev: number | bigint; readonly ino: number | bigint },
): Promise<void> {
  const current = await lstat(candidate);
  const currentPath = await realpath(candidate);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    !sameFile(current, pinned) ||
    currentPath !== canonicalPath ||
    !inside(repo, currentPath)
  )
    throw new Error('--input changed during bounded repository preflight');
}

async function readBoundedText(
  handle: Awaited<ReturnType<typeof open>>,
  initial: { readonly dev: number | bigint; readonly ino: number | bigint },
  byteLimit: number,
  signal?: AbortSignal,
): Promise<{ readonly content: string; readonly bytes: number }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    if (signal?.aborted)
      throw new GitCommandError('repository preflight interrupted', 'aborted');
    const buffer = Buffer.alloc(
      Math.min(inputReadChunkBytes, byteLimit - bytes + 1),
    );
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    bytes += bytesRead;
    if (bytes > byteLimit)
      throw new Error('delegated inputs exceed the bounded size limit');
    chunks.push(buffer.subarray(0, bytesRead));
  }
  const after = await handle.stat();
  if (!after.isFile() || !sameFile(after, initial) || after.size !== bytes)
    throw new Error('--input changed while bounded contents were read');
  try {
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, bytes),
      ),
      bytes,
    };
  } catch {
    throw new Error('--input must be UTF-8 text');
  }
}

async function validateRepo(
  request: ParsedRequest,
  signal?: AbortSignal,
): Promise<{
  readonly repo: string;
  readonly inputs: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}> {
  const repo = await realpath(request.repo);
  const rootResult = await git(repo, ['rev-parse', '--show-toplevel'], signal);
  if (
    rootResult.status !== 0 ||
    rootResult.stderr ||
    (await realpath(rootResult.stdout.trim())) !== repo
  )
    throw new Error('--repo must be the canonical repository root');
  let totalBytes = 0;
  const inputs: { path: string; content: string }[] = [];
  const canonicalInputs = new Set<string>();
  for (const input of request.inputs) {
    if (signal?.aborted)
      throw new GitCommandError('repository preflight interrupted', 'aborted');
    const candidate = resolve(repo, input);
    if (!inside(repo, candidate))
      throw new Error('--input must be inside --repo');
    const path = await realpath(candidate);
    if (!inside(repo, path))
      throw new Error('--input must resolve inside --repo');
    if (canonicalInputs.has(path))
      throw new Error(
        '--input paths must be unique after canonical resolution',
      );
    canonicalInputs.add(path);
    const pathFromRepo = relative(repo, path);
    const segments = pathFromRepo.split(sep);
    if (segments.some((part) => ['.git', '.krn', '.codex'].includes(part)))
      throw new Error('private repository state cannot be delegated');
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('--input must be a regular nonsymlink file');
    if (!fsConstants.O_NOFOLLOW)
      throw new Error('this platform cannot pin delegated input files safely');
    const handle = await open(
      candidate,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const pinned = await handle.stat();
      if (!pinned.isFile() || !sameFile(pinned, info))
        throw new Error('--input changed while it was opened');
      await ensurePinnedPath(candidate, path, repo, pinned);
      if (
        pinned.size > maxInputBytes ||
        totalBytes + pinned.size > maxTotalInputBytes
      )
        throw new Error('delegated inputs exceed the bounded size limit');
      const tracked = await git(
        repo,
        [
          '--literal-pathspecs',
          'ls-files',
          '-z',
          '--error-unmatch',
          '--',
          pathFromRepo,
        ],
        signal,
      );
      if (
        tracked.status !== 0 ||
        tracked.stderr ||
        !tracked.stdout.split('\0').includes(pathFromRepo)
      )
        throw new Error('--input must be a tracked repository file');
      await ensurePinnedPath(candidate, path, repo, pinned);
      const remainingBytes = Math.min(
        maxInputBytes,
        maxTotalInputBytes - totalBytes,
      );
      const read = await readBoundedText(
        handle,
        pinned,
        remainingBytes,
        signal,
      );
      if (read.content.includes('\0'))
        throw new Error('--input must be UTF-8 text');
      await ensurePinnedPath(candidate, path, repo, pinned);
      totalBytes += read.bytes;
      inputs.push({ path: pathFromRepo, content: read.content });
    } finally {
      await handle.close();
    }
  }
  return { repo, inputs };
}

async function ensurePrivateResultsDirectory(
  repo: string,
  requested: string,
  signal?: AbortSignal,
): Promise<string> {
  const base = join(repo, '.krn', 'tmp');
  if (!inside(base, requested))
    throw new Error('--results must be a new directory under <repo>/.krn/tmp');
  const ignored = await git(repo, ['check-ignore', '-q', '.krn/tmp'], signal);
  if (ignored.status !== 0 || ignored.stderr)
    throw new Error('repository must ignore .krn/tmp');
  if (signal?.aborted)
    throw new GitCommandError('repository preflight interrupted', 'aborted');
  for (const directory of [join(repo, '.krn'), base]) {
    if (signal?.aborted)
      throw new GitCommandError('repository preflight interrupted', 'aborted');
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
    if (signal?.aborted)
      throw new GitCommandError('repository preflight interrupted', 'aborted');
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
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
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
  const startupController = new AbortController();
  const cancel = () => {
    startupController.abort();
    if (sessionId)
      cancelPromise ??= host.cancelTree(sessionId).catch((error: unknown) => {
        cancelFailure = error;
      });
  };
  if (signal?.aborted)
    return {
      id,
      brief,
      status: 'cancelled',
      resultFile,
      resultPersisted: false,
    };

  const timeout = setTimeout(() => {
    timedOut = true;
    cancel();
  }, request.timeoutMs);
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
      signal: startupController.signal,
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
        resultPersisted: false,
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
        resultPersisted: false,
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
        resultPersisted: false,
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
        resultPersisted: false,
        ...(finalText === undefined ? {} : { finalText }),
        exitCode: result.exitCode,
        signal: result.signal,
      };
    return {
      id,
      brief,
      status: 'completed',
      resultFile,
      resultPersisted: false,
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
        resultPersisted: false,
        errorType: errorType(cancelFailure),
      };
    if (timedOut)
      return {
        id,
        brief,
        status: 'timeout',
        resultFile,
        resultPersisted: false,
        errorType: errorType(error),
      };
    if (signal?.aborted)
      return {
        id,
        brief,
        status: 'cancelled',
        resultFile,
        resultPersisted: false,
        errorType: errorType(error),
      };
    return {
      id,
      brief,
      status: 'failed',
      resultFile,
      resultPersisted: false,
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
  const validated = await validateRepo(request, runtime.signal);
  const resultsDirectory = await ensurePrivateResultsDirectory(
    validated.repo,
    request.results,
    runtime.signal,
  );
  if (runtime.signal?.aborted)
    throw new GitCommandError('repository preflight interrupted', 'aborted');
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
        if (!result.resultFile)
          throw new Error('worker result path is missing before persistence');
        const persisted = { ...result, resultPersisted: true };
        await atomicJson(result.resultFile, persisted);
        workers[index] = persisted;
      } catch (error) {
        const { resultFile: _resultFile, ...unpersisted } = result;
        workers[index] = {
          ...unpersisted,
          resultPersisted: false,
          resultPersistenceErrorType: errorType(error),
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: request.concurrency }, () => runSlot()),
  );
  let group: DelegateGroupResult = {
    kind: 'delegate_group',
    resultsDirectory,
    workers,
    manifestPersisted: true,
  };
  try {
    await atomicJson(join(resultsDirectory, 'group.json'), group);
  } catch (error) {
    group = {
      ...group,
      manifestPersisted: false,
      manifestPersistenceErrorType: errorType(error),
    };
  }
  (runtime.write ?? ((text) => process.stdout.write(text)))(
    `${JSON.stringify(group)}\n`,
  );
  const exitCode =
    !group.manifestPersisted ||
    workers.some(
      (worker) => worker.status === 'failed' || !worker.resultPersisted,
    )
      ? 1
      : workers.some((worker) => worker.status === 'timeout')
        ? 124
        : workers.some((worker) => worker.status === 'cancelled')
          ? 130
          : 0;
  runtime.setExitCode?.(exitCode);
  return group;
}
