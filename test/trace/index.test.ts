import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import type { Job } from '../../src/core/index.ts';
import { stateDirectory } from '../../src/foreman/state.ts';
import { hasVerdict, verdict } from '../../src/trace/index.ts';
import type { VerdictEvent } from '../../src/verdict/index.ts';

async function fixture(): Promise<{
  job: Job;
  directory: string;
  tracePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'krn-trace-test-'));
  const initialized = spawnSync('git', ['-C', directory, 'init', '--quiet'], {
    encoding: 'utf8',
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const job: Job = {
    id: `trace-test-${randomUUID()}`,
    issue: 'LON-228',
    worktree: directory,
    repoRoot: directory,
  };
  return {
    job,
    directory,
    tracePath: join(stateDirectory(job), 'trace.jsonl'),
  };
}

function event(sha: string, exitCode: number, checkSha: string): VerdictEvent {
  return {
    sha,
    checks: [{ id: 'gate', exitCode, durationMs: 1, sha256: checkSha }],
  };
}

test('trace recovers and reports an incomplete tail but rejects completed corruption', async () => {
  const f = await fixture();
  const sha = 'a'.repeat(40);
  try {
    await verdict(f.job, event(sha, 0, 'b'.repeat(64)));
    await appendFile(f.tracePath, '{"key":"torn"');

    let readable = false;
    let diagnostic = '';
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => {
      diagnostic = values.map(String).join(' ');
    };
    try {
      try {
        readable = await hasVerdict(f.job, sha);
      } catch {
        readable = false;
      }
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(
      readable,
      true,
      'a torn tail must not hide the durable verdict',
    );
    assert.match(diagnostic, /torn final trace line/u);
    await verdict(f.job, event('c'.repeat(40), 0, 'd'.repeat(64)));

    const later = JSON.stringify({
      key: 'later-valid-row',
      kind: 'verdict',
      at: new Date().toISOString(),
      data: { sha, checks: event(sha, 0, 'c'.repeat(64)).checks },
    });
    await appendFile(
      f.tracePath,
      `{"key":"broken","kind":"verdict","at":"now","data":}}\n${later}\n`,
    );
    await assert.rejects(hasVerdict(f.job, sha), SyntaxError);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace records fail then pass at one SHA and deduplicates exact evidence', async () => {
  const f = await fixture();
  const sha = 'd'.repeat(40);
  const failed = event(sha, 1, 'e'.repeat(64));
  const passed = event(sha, 0, 'f'.repeat(64));
  try {
    await verdict(f.job, failed);
    const failOnlyCountsAsPassing = await hasVerdict(f.job, sha);
    await verdict(f.job, failed);
    await verdict(f.job, passed);

    const rows = (await readFile(f.tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            data: { sha: string; checks: Array<{ exitCode: number }> };
          },
      );
    assert.equal(
      rows.length,
      2,
      'distinct verdict results must both be recorded',
    );
    assert.equal(rows.at(-1)?.data.sha, sha);
    assert.ok(rows.at(-1)?.data.checks.every((check) => check.exitCode === 0));
    assert.equal(failOnlyCountsAsPassing, false);
    assert.equal(await hasVerdict(f.job, sha), true);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace rejects FIFO paths immediately for append and read', {
  timeout: 5000,
}, async () => {
  const f = await fixture();
  try {
    await mkdir(dirname(f.tracePath), { recursive: true });
    const fifo = spawnSync('mkfifo', [f.tracePath], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr);

    const moduleUrl = new URL('../../src/trace/index.ts', import.meta.url).href;
    for (const operation of ['append', 'read'] as const) {
      const worker = new Worker(
        `
            import { parentPort, workerData } from 'node:worker_threads';
            const { hasVerdict, intent } = await import(workerData.moduleUrl);
            try {
              if (workerData.operation === 'append') await intent(workerData.job, 1);
              else await hasVerdict(workerData.job, '${'a'.repeat(40)}');
              parentPort.postMessage({ message: 'unexpected success' });
            } catch (error) {
              parentPort.postMessage({ message: error?.message });
            }
          `,
        {
          eval: true,
          workerData: { moduleUrl, operation, job: f.job },
        },
      );
      let timedOut = false;
      try {
        const result = await new Promise<{ message: string }>(
          (resolve, reject) => {
            const timer = setTimeout(() => {
              timedOut = true;
              reject(new Error(`${operation} hung while opening a FIFO`));
            }, 1000);
            worker.once('message', (value: { message: string }) => {
              clearTimeout(timer);
              resolve(value);
            });
            worker.once('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });
          },
        );
        assert.deepEqual(result, { message: 'unsafe trace path' });
      } finally {
        if (timedOut) {
          worker.unref();
          void worker.terminate();
        } else {
          await worker.terminate();
        }
      }
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
