import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dispatch } from '../../src/cli/index.ts';
import type { CodexSessionResult } from '../../src/hosts/codex.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function createTrackedFixture(): Promise<{
  readonly repo: string;
  readonly input: string;
}> {
  const repo = await mkdtemp(join(tmpdir(), 'krn-delegate-group-'));
  const input = join(repo, 'input.txt');
  await mkdir(join(repo, '.krn', 'tmp'), { recursive: true });
  await writeFile(join(repo, '.gitignore'), '.krn/\n');
  await writeFile(input, 'public fixture input\n');
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('config', 'user.name', 'KRN delegate test');
  git('config', 'user.email', 'delegate@example.invalid');
  git('add', '.gitignore', 'input.txt');
  git('commit', '-qm', 'create tracked input fixture');
  return { repo, input };
}

function argsFor(
  repo: string,
  input: string,
  results: string,
  briefs: readonly string[],
  timeoutMs = '10000',
): string[] {
  return [
    'delegate',
    '--repo',
    repo,
    '--input',
    input,
    '--results',
    results,
    ...briefs.flatMap((brief) => ['--brief', brief]),
    '--timeout-ms',
    timeoutMs,
    '--concurrency',
    String(briefs.length),
  ];
}

function completedSession(
  sessionId: string,
  finalMessage: string,
): CodexSessionResult {
  return {
    sessionId,
    reasonKind: 'agent_message',
    reasonSha256: '0'.repeat(64),
    reasonLength: Buffer.byteLength(finalMessage),
    claimsDone: true,
    finalMessage,
    exitCode: 0,
    signal: null,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    usageObservation: { turnsStarted: 1, turnsCompleted: 1, invalidFields: 0 },
  };
}

test('delegate emits one persisted group result only after every worker completes', async () => {
  const { repo, input } = await createTrackedFixture();
  try {
    const results = join(repo, '.krn', 'tmp', 'delegation', 'group-one');
    const sessions = [
      deferred<CodexSessionResult>(),
      deferred<CodexSessionResult>(),
    ];
    const starts = [deferred<void>(), deferred<void>()];
    let output = '';
    let invocationDone = false;
    const invocation = dispatch(
      argsFor(repo, input, results, ['TASK A', 'TASK B']),
      {
        delegate: {
          signal: new AbortController().signal,
          write: (value: string) => {
            output += value;
          },
          host: {
            start: async (request: { prompt: string }) => {
              const index = request.prompt.includes('TASK A') ? 0 : 1;
              const session = sessions[index];
              if (!session) throw new Error('fake worker was not configured');
              starts[index]?.resolve();
              return {
                id: `worker-${index}`,
                wait: () => session.promise,
              };
            },
            cancelTree: async () => undefined,
          },
        },
      },
    ).then((handled) => {
      invocationDone = true;
      return handled;
    });

    await Promise.race([
      Promise.all(starts.map((start) => start.promise)),
      invocation.then((handled) => {
        assert.equal(handled, true, 'delegate must be a KRN command');
        assert.fail('delegate returned before starting the selected group');
      }),
    ]);
    assert.equal(invocationDone, false);
    assert.equal(output, '', 'no progress or partial result is emitted');

    const firstPersisted = new Promise<void>((resolve) => {
      const watcher = watch(results, (_event, name) => {
        if (name?.toString() === 'worker-1.json') {
          watcher.close();
          resolve();
        }
      });
    });
    sessions[0]?.resolve(completedSession('worker-0', 'Full result A'));
    await firstPersisted;
    assert.equal(invocationDone, false);
    assert.equal(output, '', 'the group waits for the second worker');

    sessions[1]?.resolve(completedSession('worker-1', 'Full result B'));
    assert.equal(await invocation, true);
    assert.equal(output.endsWith('\n'), true);
    const aggregate = JSON.parse(output) as {
      readonly workers: readonly {
        readonly status: string;
        readonly finalText?: string;
        readonly resultFile: string;
      }[];
    };
    assert.equal(aggregate.workers.length, 2);
    assert.deepEqual(
      aggregate.workers.map(({ status, finalText }) => [status, finalText]),
      [
        ['completed', 'Full result A'],
        ['completed', 'Full result B'],
      ],
    );
    for (const worker of aggregate.workers) {
      const persisted = JSON.parse(
        await readFile(worker.resultFile, 'utf8'),
      ) as {
        readonly status: string;
        readonly resultPersisted: boolean;
        readonly finalText?: string;
      };
      assert.equal(persisted.status, worker.status);
      assert.equal(persisted.resultPersisted, true);
      assert.equal(persisted.finalText, worker.finalText);
    }
    assert.equal(output.trimEnd().split('\n').length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate cancels an owned worker on caller interruption and persists cancelled state', async () => {
  const { repo, input } = await createTrackedFixture();
  try {
    const results = join(repo, '.krn', 'tmp', 'delegation', 'cancelled');
    const started = deferred<void>();
    const interrupted = deferred<CodexSessionResult>();
    const controller = new AbortController();
    let cancelCalls = 0;
    const invocation = dispatch(argsFor(repo, input, results, ['TASK']), {
      delegate: {
        signal: controller.signal,
        write: () => undefined,
        host: {
          start: async () => {
            started.resolve();
            return { id: 'owned-worker', wait: () => interrupted.promise };
          },
          cancelTree: async () => {
            cancelCalls += 1;
            interrupted.resolve({
              claimsDone: false,
              exitCode: null,
              signal: 'SIGTERM',
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              usageObservation: {
                turnsStarted: 1,
                turnsCompleted: 0,
                invalidFields: 0,
              },
              sessionId: 'owned-worker',
              reasonKind: 'process_exit',
              reasonSha256: '0'.repeat(64),
              reasonLength: 0,
            });
          },
        },
      },
    });
    await started.promise;
    controller.abort();
    assert.equal(await invocation, true);
    assert.equal(cancelCalls, 1);
    const aggregate = JSON.parse(
      await readFile(join(results, 'group.json'), 'utf8'),
    ) as {
      readonly workers: readonly { readonly status: string }[];
    };
    assert.deepEqual(
      aggregate.workers.map(({ status }) => status),
      ['cancelled'],
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate preserves resolved host summary when caller cancellation cleanup fails', async () => {
  const { repo, input } = await createTrackedFixture();
  try {
    const results = join(
      repo,
      '.krn',
      'tmp',
      'delegation',
      'cancel-cleanup-failure',
    );
    const started = deferred<void>();
    const cleanupStarted = deferred<void>();
    const hostResult = deferred<CodexSessionResult>();
    const controller = new AbortController();
    let output = '';
    const invocation = dispatch(argsFor(repo, input, results, ['TASK']), {
      delegate: {
        signal: controller.signal,
        write: (text) => {
          output += text;
        },
        host: {
          start: async () => {
            started.resolve();
            return {
              id: 'cleanup-failure-handle',
              wait: () => hostResult.promise,
            };
          },
          cancelTree: async () => {
            cleanupStarted.resolve();
            throw new Error('cleanup failed');
          },
        },
      },
    });
    await started.promise;
    controller.abort();
    await cleanupStarted.promise;
    hostResult.resolve({
      sessionId: 'resolved-session-456',
      reasonKind: 'process_exit',
      reasonSha256: 'b'.repeat(64),
      reasonLength: 0,
      claimsDone: false,
      exitCode: null,
      signal: 'SIGTERM',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      usageObservation: {
        turnsStarted: 1,
        turnsCompleted: 0,
        invalidFields: 0,
      },
    });
    await invocation;

    const aggregate = JSON.parse(output) as {
      readonly workers: readonly Record<string, unknown>[];
    };
    const worker = aggregate.workers[0];
    assert.equal(worker?.status, 'failed');
    assert.equal(worker?.sessionId, 'resolved-session-456');
    assert.equal(worker?.reasonKind, 'process_exit');
    assert.equal(worker?.reasonSha256, 'b'.repeat(64));
    assert.equal(worker?.reasonLength, 0);
    assert.equal(worker?.errorType, 'Error');
    assert.equal(JSON.stringify(worker).includes('stderr'), false);
    const persisted = JSON.parse(
      await readFile(join(results, 'worker-1.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.deepEqual(persisted, worker);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate keeps timeout distinct from caller cancellation and waits for cleanup', async () => {
  const { repo, input } = await createTrackedFixture();
  try {
    const results = join(repo, '.krn', 'tmp', 'delegation', 'timed-out');
    const started = deferred<void>();
    const cancellation = deferred<void>();
    const timedOut = deferred<CodexSessionResult>();
    let cancelCalls = 0;
    const invocation = dispatch(
      argsFor(repo, input, results, ['TASK'], '1000'),
      {
        delegate: {
          write: () => undefined,
          host: {
            start: async () => {
              started.resolve();
              return { id: 'timed-worker', wait: () => timedOut.promise };
            },
            cancelTree: async () => {
              cancelCalls += 1;
              timedOut.resolve({
                claimsDone: false,
                exitCode: null,
                signal: 'SIGTERM',
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                usageObservation: {
                  turnsStarted: 1,
                  turnsCompleted: 0,
                  invalidFields: 0,
                },
                sessionId: 'timed-worker',
                reasonKind: 'process_exit',
                reasonSha256: '0'.repeat(64),
                reasonLength: 0,
              });
              cancellation.resolve();
            },
          },
        },
      },
    );
    await started.promise;
    await cancellation.promise;
    assert.equal(await invocation, true);
    assert.equal(cancelCalls, 1);
    const aggregate = JSON.parse(
      await readFile(join(results, 'group.json'), 'utf8'),
    ) as {
      readonly workers: readonly { readonly status: string }[];
    };
    assert.deepEqual(
      aggregate.workers.map(({ status }) => status),
      ['timeout'],
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate cancels and joins a pending host startup at its deadline', async () => {
  const { repo, input } = await createTrackedFixture();
  try {
    const results = join(repo, '.krn', 'tmp', 'delegation', 'startup-timeout');
    const cancellationObserved = deferred<void>();
    const cleanupSettled = deferred<void>();
    let invocationDone = false;
    let returnedSession = false;
    let exitCode: number | undefined;
    const invocation = dispatch(
      argsFor(repo, input, results, ['TASK'], '1000'),
      {
        delegate: {
          write: () => undefined,
          setExitCode: (code) => {
            exitCode = code;
          },
          host: {
            start: async (request: { readonly signal?: AbortSignal }) => {
              await new Promise<never>((_resolve, reject) => {
                request.signal?.addEventListener(
                  'abort',
                  () => {
                    cancellationObserved.resolve();
                    setTimeout(() => {
                      cleanupSettled.resolve();
                      reject(
                        new Error('startup cancellation cleanup complete'),
                      );
                    }, 30);
                  },
                  { once: true },
                );
              });
              returnedSession = true;
              throw new Error('unreachable');
            },
            cancelTree: async () => undefined,
          },
        },
      },
    ).finally(() => {
      invocationDone = true;
    });
    await Promise.race([
      cancellationObserved.promise,
      new Promise<void>((_resolve, reject) => {
        setTimeout(
          () =>
            reject(new Error('deadline never reached startup cancellation')),
          1500,
        );
      }),
    ]);
    assert.equal(
      invocationDone,
      false,
      'the aggregate waits for start cleanup acknowledgement',
    );
    await cleanupSettled.promise;
    await invocation;
    assert.equal(invocationDone, true);
    assert.equal(exitCode, 124);
    assert.equal(
      returnedSession,
      false,
      'an aborted startup cannot return a late session',
    );
    const group = JSON.parse(
      await readFile(join(results, 'group.json'), 'utf8'),
    ) as {
      readonly workers: readonly { readonly status: string }[];
    };
    assert.deepEqual(
      group.workers.map(({ status }) => status),
      ['timeout'],
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate refuses untracked inputs before starting any worker', async () => {
  const { repo } = await createTrackedFixture();
  try {
    const privateInput = join(repo, 'private-session.txt');
    const results = join(repo, '.krn', 'tmp', 'delegation', 'private-input');
    await writeFile(privateInput, 'private fixture data\n');
    let starts = 0;
    await assert.rejects(
      dispatch(argsFor(repo, privateInput, results, ['TASK']), {
        delegate: {
          host: {
            start: async () => {
              starts += 1;
              throw new Error('unreachable');
            },
            cancelTree: async () => undefined,
          },
          write: () => undefined,
        },
      }),
      /--input must be a tracked repository file/u,
    );
    assert.equal(starts, 0);
    await assert.rejects(readFile(join(results, 'group.json')));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate records a nonzero worker exit as failed even with final text', async () => {
  const { repo, input } = await createTrackedFixture();
  try {
    const results = join(repo, '.krn', 'tmp', 'delegation', 'failed');
    let output = '';
    let exitCode: number | undefined;
    const failed = completedSession('failed-worker', 'untrusted final text');
    const invocation = await dispatch(argsFor(repo, input, results, ['TASK']), {
      delegate: {
        write: (text) => {
          output += text;
        },
        setExitCode: (code) => {
          exitCode = code;
        },
        host: {
          start: async () => ({
            id: failed.sessionId,
            wait: async () => ({ ...failed, exitCode: 17 }),
          }),
          cancelTree: async () => undefined,
        },
      },
    });
    assert.equal(invocation, true);
    assert.equal(exitCode, 1);
    const aggregate = JSON.parse(output) as {
      readonly workers: readonly { readonly status: string }[];
    };
    assert.deepEqual(
      aggregate.workers.map(({ status }) => status),
      ['failed'],
    );
    const persisted = JSON.parse(
      await readFile(join(results, 'worker-1.json'), 'utf8'),
    ) as {
      readonly status: string;
      readonly finalText?: string;
    };
    assert.equal(persisted.status, 'failed');
    assert.equal(persisted.finalText, 'untrusted final text');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate preserves bounded host identity and termination summary for an external SIGTERM', async () => {
  const { repo, input } = await createTrackedFixture();
  try {
    const results = join(repo, '.krn', 'tmp', 'delegation', 'external-sigterm');
    const sessionId = 'session-sigterm-123';
    let output = '';
    let exitCode: number | undefined;
    await dispatch(argsFor(repo, input, results, ['TASK']), {
      delegate: {
        signal: new AbortController().signal,
        write: (text) => {
          output += text;
        },
        setExitCode: (code) => {
          exitCode = code;
        },
        host: {
          start: async () => ({
            id: 'worker-handle-123',
            wait: async () => ({
              sessionId,
              reasonKind: 'process_exit',
              reasonSha256: 'a'.repeat(64),
              reasonLength: 0,
              claimsDone: false,
              exitCode: null,
              signal: 'SIGTERM',
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              usageObservation: {
                turnsStarted: 1,
                turnsCompleted: 0,
                invalidFields: 0,
              },
            }),
          }),
          cancelTree: async () => undefined,
        },
      },
    });

    const group = JSON.parse(output) as {
      readonly workers: readonly Record<string, unknown>[];
    };
    const worker = group.workers[0];
    assert.equal(exitCode, 1);
    assert.equal(worker?.status, 'failed');
    assert.equal(worker?.signal, 'SIGTERM');
    assert.equal(worker?.sessionId, sessionId);
    assert.equal(worker?.reasonKind, 'process_exit');
    assert.equal(worker?.reasonSha256, 'a'.repeat(64));
    assert.equal(worker?.reasonLength, 0);
    assert.equal(JSON.stringify(worker).includes('stderr'), false);
    const persisted = JSON.parse(
      await readFile(join(results, 'worker-1.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.deepEqual(persisted, worker);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate reports an unpersisted worker result without claiming its file exists', async () => {
  const { repo, input } = await createTrackedFixture();
  try {
    const results = join(
      repo,
      '.krn',
      'tmp',
      'delegation',
      'worker-write-failure',
    );
    const blockedResultPath = join(results, 'worker-1.json');
    let output = '';
    let exitCode: number | undefined;
    await dispatch(argsFor(repo, input, results, ['TASK']), {
      delegate: {
        write: (text) => {
          output += text;
        },
        setExitCode: (code) => {
          exitCode = code;
        },
        host: {
          start: async () => {
            await mkdir(blockedResultPath);
            return {
              id: 'persist-failure-worker',
              wait: async () =>
                completedSession('persist-failure-worker', 'full result'),
            };
          },
          cancelTree: async () => undefined,
        },
      },
    });
    const group = JSON.parse(output) as {
      readonly manifestPersisted: boolean;
      readonly workers: readonly {
        readonly status: string;
        readonly resultPersisted: boolean;
        readonly resultPersistenceErrorType?: string;
        readonly resultFile?: string;
        readonly finalText?: string;
      }[];
    };
    assert.equal(exitCode, 1);
    assert.equal(group.manifestPersisted, true);
    assert.equal(group.workers[0]?.status, 'completed');
    assert.equal(group.workers[0]?.resultPersisted, false);
    assert.equal(group.workers[0]?.resultFile, undefined);
    assert.equal(group.workers[0]?.resultPersistenceErrorType, 'Error');
    assert.equal(group.workers[0]?.finalText, 'full result');
    assert.equal(
      (await readFile(join(results, 'group.json'), 'utf8')).includes(
        '"manifestPersisted": true',
      ),
      true,
    );
    await assert.rejects(readFile(blockedResultPath, 'utf8'), {
      code: 'EISDIR',
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate reports an unpersisted group manifest in its final aggregate', async () => {
  const { repo, input } = await createTrackedFixture();
  try {
    const results = join(
      repo,
      '.krn',
      'tmp',
      'delegation',
      'manifest-write-failure',
    );
    const blockedManifestPath = join(results, 'group.json');
    let output = '';
    let exitCode: number | undefined;
    await dispatch(argsFor(repo, input, results, ['TASK']), {
      delegate: {
        write: (text) => {
          output += text;
        },
        setExitCode: (code) => {
          exitCode = code;
        },
        host: {
          start: async () => {
            await mkdir(blockedManifestPath);
            return {
              id: 'manifest-failure-worker',
              wait: async () =>
                completedSession('manifest-failure-worker', 'full result'),
            };
          },
          cancelTree: async () => undefined,
        },
      },
    });
    const group = JSON.parse(output) as {
      readonly manifestPersisted: boolean;
      readonly manifestPersistenceErrorType?: string;
      readonly workers: readonly {
        readonly resultPersisted: boolean;
        readonly resultFile?: string;
      }[];
    };
    assert.equal(exitCode, 1);
    assert.equal(group.manifestPersisted, false);
    assert.equal(group.manifestPersistenceErrorType, 'Error');
    assert.equal(group.workers[0]?.resultPersisted, true);
    assert.ok(group.workers[0]?.resultFile);
    await assert.rejects(readFile(blockedManifestPath, 'utf8'), {
      code: 'EISDIR',
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate rejects a literal wildcard filename that is not tracked', async () => {
  const { repo } = await createTrackedFixture();
  try {
    const wildcardInput = join(repo, 'input*');
    await writeFile(wildcardInput, 'untracked wildcard fixture\n');
    let starts = 0;
    await assert.rejects(
      dispatch(
        argsFor(
          repo,
          wildcardInput,
          join(repo, '.krn', 'tmp', 'delegation', 'literal-wildcard'),
          ['TASK'],
        ),
        {
          delegate: {
            host: {
              start: async () => {
                starts += 1;
                throw new Error('unreachable');
              },
              cancelTree: async () => undefined,
            },
            write: () => undefined,
          },
        },
      ),
      /--input must be a tracked repository file/u,
    );
    assert.equal(starts, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate never reads a pathname replaced after input validation', async () => {
  const { repo, input } = await createTrackedFixture();
  const wrapperDir = await mkdtemp(join(tmpdir(), 'krn-delegate-git-'));
  const priorPath = process.env.PATH;
  try {
    const secret = join(repo, 'secret.txt');
    await writeFile(secret, 'private swap marker\n');
    const realGit = spawnSync('which', ['git'], {
      encoding: 'utf8',
    }).stdout.trim();
    const wrapper = join(wrapperDir, 'git');
    await writeFile(
      wrapper,
      `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nimport { unlinkSync, symlinkSync } from 'node:fs';\nconst args = process.argv.slice(2);\nif (args.includes('ls-files')) { unlinkSync(${JSON.stringify(input)}); symlinkSync(${JSON.stringify(secret)}, ${JSON.stringify(input)}); }\nconst child = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });\nprocess.exitCode = child.status ?? 1;\n`,
    );
    await chmod(wrapper, 0o700);
    process.env.PATH = `${wrapperDir}:${priorPath ?? ''}`;
    let starts = 0;
    await assert.rejects(
      dispatch(
        argsFor(
          repo,
          input,
          join(repo, '.krn', 'tmp', 'delegation', 'symlink-race'),
          ['TASK'],
        ),
        {
          delegate: {
            host: {
              start: async () => {
                starts += 1;
                throw new Error('unreachable');
              },
              cancelTree: async () => undefined,
            },
            write: () => undefined,
          },
        },
      ),
      /input changed during bounded repository preflight/u,
    );
    assert.equal(starts, 0);
  } finally {
    process.env.PATH = priorPath;
    await rm(wrapperDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate bounds bytes actually read when a validated file grows', async () => {
  const { repo, input } = await createTrackedFixture();
  const wrapperDir = await mkdtemp(join(tmpdir(), 'krn-delegate-git-'));
  const priorPath = process.env.PATH;
  try {
    const realGit = spawnSync('which', ['git'], {
      encoding: 'utf8',
    }).stdout.trim();
    const wrapper = join(wrapperDir, 'git');
    await writeFile(
      wrapper,
      `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nif (args.includes('ls-files')) writeFileSync(${JSON.stringify(input)}, 'x'.repeat(2 * 1024 * 1024 + 1));\nconst child = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });\nprocess.exitCode = child.status ?? 1;\n`,
    );
    await chmod(wrapper, 0o700);
    process.env.PATH = `${wrapperDir}:${priorPath ?? ''}`;
    let starts = 0;
    await assert.rejects(
      dispatch(
        argsFor(
          repo,
          input,
          join(repo, '.krn', 'tmp', 'delegation', 'growth-race'),
          ['TASK'],
        ),
        {
          delegate: {
            host: {
              start: async () => {
                starts += 1;
                return {
                  id: 'growth-worker',
                  wait: async () => completedSession('growth-worker', 'done'),
                };
              },
              cancelTree: async () => undefined,
            },
            write: () => undefined,
          },
        },
      ),
      /bounded size limit/u,
    );
    assert.equal(starts, 0);
  } finally {
    process.env.PATH = priorPath;
    await rm(wrapperDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate preflight interruption terminates and joins its Git child', async () => {
  const { repo, input } = await createTrackedFixture();
  const wrapperDir = await mkdtemp(join(tmpdir(), 'krn-delegate-git-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const marker = join(wrapperDir, 'started');
    const realGit = spawnSync('which', ['git'], {
      encoding: 'utf8',
    }).stdout.trim();
    const wrapper = join(wrapperDir, 'git');
    await writeFile(
      wrapper,
      `#!/bin/sh\nprintf started > ${JSON.stringify(marker)}\n/usr/bin/sleep 3\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    await chmod(wrapper, 0o700);
    const cli = new URL('../../src/cli/main.ts', import.meta.url);
    let stdout = '';
    let stderr = '';
    const command = spawn(
      process.execPath,
      [
        cli.pathname,
        ...argsFor(
          repo,
          input,
          join(repo, '.krn', 'tmp', 'delegation', 'interrupted-preflight'),
          ['TASK'],
        ),
      ],
      {
        env: {
          ...process.env,
          PATH: `${wrapperDir}:${process.env.PATH ?? ''}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child = command;
    command.stdout.setEncoding('utf8').on('data', (value: string) => {
      stdout += value;
    });
    command.stderr.setEncoding('utf8').on('data', (value: string) => {
      stderr += value;
    });
    const started = new Promise<void>((resolve, reject) => {
      const watcher = watch(wrapperDir, (_event, name) => {
        if (name?.toString() === 'started') {
          watcher.close();
          resolve();
        }
      });
      watcher.once('error', reject);
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      command.once('close', (code, signal) => resolve({ code, signal })),
    );
    await started;
    const interruptedAt = Date.now();
    command.kill('SIGINT');
    const result = await closed;
    assert.equal(result.code, 130, `stdout=${stdout}\nstderr=${stderr}`);
    assert.equal(stdout, '', 'preflight interruption emits no group result');
    assert.match(stderr, /repository preflight interrupted/u);
    assert.ok(
      Date.now() - interruptedAt < 1000,
      'preflight waits for child termination promptly',
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) =>
        child?.once('close', () => resolve()),
      );
    }
    await rm(wrapperDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate ignores inherited Git index overrides for input admission', async () => {
  const { repo } = await createTrackedFixture();
  const priorIndex = process.env.GIT_INDEX_FILE;
  try {
    const input = join(repo, 'alternate-index-only.txt');
    const alternateIndex = join(repo, '.git', 'delegate-alternate.index');
    await writeFile(input, 'current tracked-worktree fixture\n');
    await writeFile(
      alternateIndex,
      await readFile(join(repo, '.git', 'index')),
    );
    const indexed = spawnSync(
      'git',
      ['-C', repo, 'add', '--', 'alternate-index-only.txt'],
      {
        encoding: 'utf8',
        env: { ...process.env, GIT_INDEX_FILE: alternateIndex },
      },
    );
    assert.equal(indexed.status, 0, indexed.stderr);

    process.env.GIT_INDEX_FILE = alternateIndex;
    const results = join(repo, '.krn', 'tmp', 'delegation', 'alternate-index');
    let starts = 0;
    await assert.rejects(
      dispatch(argsFor(repo, input, results, ['TASK']), {
        delegate: {
          host: {
            start: async () => {
              starts += 1;
              return {
                id: 'alternate-index-worker',
                wait: async () =>
                  completedSession('alternate-index-worker', 'done'),
              };
            },
            cancelTree: async () => undefined,
          },
          write: () => undefined,
        },
      }),
      /--input must be a tracked repository file/u,
    );
    assert.equal(starts, 0);
    await assert.rejects(access(results), { code: 'ENOENT' });
  } finally {
    if (priorIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = priorIndex;
    await rm(repo, { recursive: true, force: true });
  }
});

test('delegate rejects duplicate canonical inputs before creating group state', async () => {
  const { repo, input } = await createTrackedFixture();
  try {
    const results = join(repo, '.krn', 'tmp', 'delegation', 'duplicate-input');
    const args = argsFor(repo, input, results, ['TASK']);
    args.splice(args.indexOf('--results'), 0, '--input', `${repo}/./input.txt`);
    let starts = 0;
    await assert.rejects(
      dispatch(args, {
        delegate: {
          host: {
            start: async () => {
              starts += 1;
              return {
                id: 'duplicate-input-worker',
                wait: async () =>
                  completedSession('duplicate-input-worker', 'done'),
              };
            },
            cancelTree: async () => undefined,
          },
          write: () => undefined,
        },
      }),
      /unique after canonical resolution/u,
    );
    assert.equal(starts, 0);
    await assert.rejects(access(results), { code: 'ENOENT' });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
