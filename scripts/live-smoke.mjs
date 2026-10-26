import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJob } from '../src/foreman/run.ts';
import { CodexHost } from '../src/hosts/codex.ts';
import * as relay from '../src/relay/index.ts';
import * as trace from '../src/trace/index.ts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.env.KRN_LIVE !== '1') {
    process.stderr.write('Set KRN_LIVE=1 to run the live Codex smoke check.\n');
    process.exit(2);
  }
  await runLiveSmoke();
}

export function createLiveSmokeLedger(targetRepo = repositoryRoot) {
  return {
    readContract: async (issue) => ({
      issueId: issue,
      identifier: issue,
      title: `Live smoke contract for ${issue}`,
      description: '',
      revision: 'live-smoke-checkpoint-v1',
      targetRepo,
      checks: ['checkpoint-file'],
    }),
  };
}

async function runLiveSmoke() {
  const executable = await resolveLiveCodexExecutable(
    process.env.KRN_LIVE_CODEX_EXECUTABLE,
    process.env.PATH,
  );
  const tmpRoot = join(repositoryRoot, '.krn', 'tmp');
  await mkdir(tmpRoot, { recursive: true });
  const cwd = await mkdtemp(join(tmpRoot, 'krn-codex-live-smoke-'));
  const jobId = `smoke-${basename(cwd).slice(-16)}`;
  const makeJob = (id) => ({
    id,
    issue: 'live-codex-checkpoint-smoke',
    worktree: cwd,
    checkpoint: { message: 'feat: live sandbox checkpoint', next: 'done' },
  });
  let job = makeJob(jobId);
  const host = new CodexHost({ executable });
  let terminationSignal;
  let cancellation;
  let retainFixture = false;
  let runFailure;
  let cleanupFailure;
  let cancelled = false;

  const handleSignal = (signal) => {
    if (terminationSignal) return;
    terminationSignal = signal;
    cancellation = host.cancelAll();
  };
  const onSigterm = () => handleSignal('SIGTERM');
  const onSigint = () => handleSignal('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  try {
    const git = (args) => {
      const result = spawnSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr || `git ${args[0]} failed`);
      return result.stdout.trim();
    };
    const initialized = spawnSync('git', [
      '-C',
      cwd,
      'init',
      '-q',
      '--initial-branch=main',
    ]);
    assert.equal(initialized.status, 0, 'could not initialize the smoke repo');
    await writeFile(join(cwd, '.gitignore'), '.krn/\n');
    await writeFile(join(cwd, 'README.md'), 'live checkpoint smoke\n');
    await writeFile(
      join(cwd, 'package.json'),
      await readFile(join(repositoryRoot, 'package.json')),
    );
    await writeFile(
      join(cwd, 'pnpm-lock.yaml'),
      await readFile(join(repositoryRoot, 'pnpm-lock.yaml')),
    );
    await writeFile(
      join(cwd, 'krn.checks.json'),
      JSON.stringify({
        version: 1,
        checks: [
          {
            id: 'checkpoint-file',
            argv: ['node', '--version'],
            timeoutMs: 20000,
          },
        ],
      }),
    );
    git([
      'add',
      '.gitignore',
      'README.md',
      'package.json',
      'pnpm-lock.yaml',
      'krn.checks.json',
    ]);
    git([
      '-c',
      'user.name=KRN live smoke',
      '-c',
      'user.email=krn-live-smoke@example.invalid',
      'commit',
      '-qm',
      'test: initialize live checkpoint smoke',
    ]);
    git(['config', 'user.name', 'KRN live smoke foreman']);
    git(['config', 'user.email', 'krn-live-foreman@example.invalid']);
    await mkdir(join(cwd, '.krn', 'runs', 'foreman', 'checkpoint'), {
      recursive: true,
      mode: 0o700,
    });

    const runSmokeSession = (attemptJob) =>
      runJob(attemptJob, {
        budget: {
          maxResets: 0,
          maxRepairs: 0,
          session: { timeoutMs: 145_000 },
        },
        ledger: createLiveSmokeLedger(cwd),
        relay: {
          ...relay,
          project: () =>
            attemptJob.id === `${jobId}-retry`
              ? `Live sandbox retry. Complete exactly these two steps in order. If the file already exists, it is pending work from the first session:\n1. Ensure live-checkpoint.txt contains exactly "checkpoint reached"; leave it unchanged if it already does.\n2. Immediately execute the exact checkpoint command that follows in your terminal to record the pending change.`
              : `Live sandbox task. Complete exactly these two steps in order:\n1. Ensure live-checkpoint.txt contains exactly "checkpoint reached".\n2. Immediately execute the exact checkpoint command that follows in your terminal.`,
        },
        trace,
        hosts: {
          codex: host,
          cancelTree: (sessionId) => host.cancelTree(sessionId),
        },
        stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
      });
    let outcome = await runSmokeSession(job);

    if (terminationSignal) {
      await cancellation;
      process.exitCode = terminationSignal === 'SIGINT' ? 130 : 143;
      cancelled = true;
    }

    if (!cancelled) {
      const readEvents = async (attemptJob) => {
        const file = join(
          cwd,
          '.krn',
          'runs',
          'foreman',
          attemptJob.id,
          'trace.jsonl',
        );
        return readFile(file, 'utf8')
          .then((value) =>
            value
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          )
          .catch(() => []);
      };
      let events = await readEvents(job);
      const endedWithoutCheckpoint =
        events.some((event) => event.kind === 'session_ended') &&
        !events.some((event) => event.kind === 'checkpoint');
      let smokeRetryReason;
      if (endedWithoutCheckpoint) {
        smokeRetryReason =
          outcome.kind === 'stop'
            ? outcome.reasons.join('; ') || 'session ended without checkpoint'
            : 'session ended without checkpoint';
        process.stdout.write(`smoke_retry: ${smokeRetryReason}\n`);
        job = makeJob(`${jobId}-retry`);
        outcome = await runSmokeSession(job);
        events = await readEvents(job);
      }

      const diagnostics = await readdir(
        join(cwd, '.krn', 'runs', 'foreman', job.id, 'diagnostics'),
      )
        .then((files) =>
          Promise.all(
            files.map((file) =>
              readFile(
                join(
                  cwd,
                  '.krn',
                  'runs',
                  'foreman',
                  job.id,
                  'diagnostics',
                  file,
                ),
                'utf8',
              ),
            ),
          ),
        )
        .then((files) => files.join('\n'))
        .catch(() => '');
      const finalMessage = await readFile(
        join(cwd, '.krn', 'runs', 'foreman', job.id, 'reason.txt'),
        'utf8',
      ).catch(() => '');
      assert.equal(
        outcome.kind,
        'verdict_pass',
        `foreman did not record a positive verdict: ${JSON.stringify(outcome)}\n${diagnostics}\n${finalMessage}`,
      );
      assert.equal(
        outcome.sha,
        git(['rev-parse', 'HEAD']),
        'verdict SHA differs from HEAD',
      );
      assert.equal(
        git(['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'live smoke repo was dirty after the sandbox verdict',
      );
      assert.equal(
        (await readFile(join(cwd, 'live-checkpoint.txt'), 'utf8')).replace(
          /\r?\n$/u,
          '',
        ),
        'checkpoint reached',
        'Codex did not create the requested checkpoint file',
      );
      const checkpoint = events.find((event) => event.kind === 'checkpoint');
      const commit = events.find((event) => event.kind === 'commit');
      assert.ok(checkpoint, 'Codex did not run the printed checkpoint command');
      assert.ok(commit, 'foreman did not record the checkpoint commit');
      assert.equal(commit.data.sessionId, checkpoint.data.sessionId);
      assert.equal(commit.data.message, 'feat: live sandbox checkpoint');
      assert.equal(commit.data.sha, git(['rev-parse', 'HEAD']));
      assert.equal(
        git(['log', '-1', '--format=%s']),
        'feat: live sandbox checkpoint',
      );
      process.stdout.write(
        `Live Codex sandbox checkpoint smoke passed: session=${commit.data.sessionId} commit=${commit.data.sha}\n`,
      );
    }
  } catch (error) {
    runFailure = error;
    retainFixture = !terminationSignal;
  } finally {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    try {
      await host.cancelAll();
      await cancellation;
    } catch (error) {
      cleanupFailure = error;
      retainFixture = !terminationSignal;
    }
    try {
      if (terminationSignal || !retainFixture)
        await rm(cwd, { recursive: true, force: true });
      else process.stderr.write(`Failure evidence retained at: ${cwd}\n`);
    } catch (error) {
      cleanupFailure = cleanupFailure
        ? new AggregateError([cleanupFailure, error], 'smoke cleanup failed')
        : error;
      retainFixture = !terminationSignal;
      if (retainFixture)
        process.stderr.write(`Failure evidence retained at: ${cwd}\n`);
    }
  }
  if (runFailure && cleanupFailure)
    throw new AggregateError(
      [runFailure, cleanupFailure],
      'smoke and cleanup failed',
    );
  if (runFailure) throw runFailure;
  if (cleanupFailure) throw cleanupFailure;
  if (cancelled) return;
}

export async function resolveLiveCodexExecutable(
  explicit,
  pathValue = process.env.PATH,
) {
  const hasExplicit = explicit !== undefined;
  const pathLike =
    hasExplicit && (isAbsolute(explicit) || explicit.includes(sep));
  const name = hasExplicit ? explicit : 'codex';
  const candidates = pathLike
    ? [resolve(explicit)]
    : (pathValue ?? '')
        .split(delimiter)
        .map((directory) => join(directory || process.cwd(), name));
  for (const candidate of candidates) {
    try {
      const [details] = await Promise.all([
        stat(candidate),
        access(candidate, constants.X_OK),
      ]);
      if (details.isFile()) return resolve(candidate);
    } catch {
      // Continue PATH lookup; an explicit candidate gets actionable guidance below.
    }
  }
  const selection = hasExplicit
    ? `KRN_LIVE_CODEX_EXECUTABLE=${explicit}`
    : 'codex on the caller PATH';
  const guidance = hasExplicit
    ? pathLike
      ? 'Set KRN_LIVE_CODEX_EXECUTABLE to an executable Codex binary.'
      : `Set KRN_LIVE_CODEX_EXECUTABLE to an executable Codex binary, or add ${explicit} to PATH.`
    : 'Set KRN_LIVE_CODEX_EXECUTABLE to an executable Codex binary, or add codex to PATH.';
  throw new Error(
    `Live smoke cannot use ${selection}: no executable file was found. ${guidance} No fixture or provider session was started.`,
  );
}
