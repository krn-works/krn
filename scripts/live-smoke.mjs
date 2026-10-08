import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJob } from '../src/foreman/run.ts';
import { CodexHost, defaultCodexExecutable } from '../src/hosts/codex.ts';
import * as relay from '../src/relay/index.ts';
import * as trace from '../src/trace/index.ts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.KRN_LIVE !== '1') {
  process.stderr.write('Set KRN_LIVE=1 to run the live Codex smoke check.\n');
  process.exit(2);
}

await runLiveSmoke();

async function runLiveSmoke() {
  const executable =
    process.env.KRN_LIVE_CODEX_EXECUTABLE ?? defaultCodexExecutable;
  const tmpRoot = join(repositoryRoot, '.krn', 'tmp');
  await mkdir(tmpRoot, { recursive: true });
  const cwd = await mkdtemp(join(tmpRoot, 'krn-codex-live-smoke-'));
  const job = {
    id: `smoke-${basename(cwd).slice(-16)}`,
    issue: 'live-codex-checkpoint-smoke',
    worktree: cwd,
  };
  const host = new CodexHost({ executable });
  let terminationSignal;
  let cancellation;

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
    git(['add', '.gitignore', 'README.md']);
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

    const outcome = await runJob(job, {
      budget: {
        maxResets: 0,
        maxRepairs: 0,
        session: { timeoutMs: 145_000 },
      },
      ledger: {
        readContract: async () => ({ revision: 'live-smoke-checkpoint-v1' }),
      },
      relay: {
        ...relay,
        project: (capsule, facts) =>
          `${relay.project(capsule, facts)}\nLive sandbox task: Run the shell command pwd. Then create a file named live-checkpoint.txt containing exactly "checkpoint reached". When the checkpoint command is printed, run it with --message "feat: live sandbox checkpoint" and --next "done". Let the foreman create the commit.`,
      },
      trace,
      hosts: {
        codex: host,
        cancelTree: (sessionId) => host.cancelTree(sessionId),
      },
      stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
    });

    if (terminationSignal) {
      await cancellation;
      process.exitCode = terminationSignal === 'SIGINT' ? 130 : 143;
      return;
    }

    assert.equal(outcome.kind, 'review', 'foreman did not finish the job');
    assert.equal(
      await readFile(join(cwd, 'live-checkpoint.txt'), 'utf8'),
      'checkpoint reached',
      'Codex did not create the requested checkpoint file',
    );
    const events = (
      await readFile(
        join(cwd, '.krn', 'runs', 'foreman', job.id, 'trace.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
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
  } finally {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    try {
      await host.cancelAll();
      await cancellation;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
