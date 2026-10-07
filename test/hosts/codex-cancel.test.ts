import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

test('cancellation kills the Codex process tree and keeps the session identity', async () => {
  const hostModule = await import('../../src/hosts/codex.ts').catch(
    () => undefined,
  );
  assert.ok(
    hostModule && 'CodexHost' in hostModule,
    'Codex host must expose cancellable sessions',
  );

  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-cancel-'));
  try {
    const pidFile = join(directory, 'pids');
    const executable = join(directory, 'fake-codex');
    const source = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } }) + '\\n');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
child.once('spawn', () => {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\\n' + String(child.pid));
});
setInterval(() => {}, 1000);
`;
    await writeFile(executable, source);
    await chmod(executable, 0o755);

    const host = new hostModule.CodexHost({ executable });
    const session = await host.start({
      cwd: directory,
      model: 'gpt-6-luna',
      prompt: 'wait',
      limits: { timeoutMs: 10_000 },
    });
    const identity = session.id;
    const pids = await waitFor(async () => {
      try {
        const lines = (await readFile(pidFile, 'utf8')).trim().split('\n');
        return lines.length === 2 ? lines.map(Number) : undefined;
      } catch {
        return undefined;
      }
    });

    await host.cancelTree(identity);
    const result = await session.wait();
    assert.equal(result.sessionId, identity);
    assert.equal(result.threadId, 'thread-123');
    assert.deepEqual(result.usage, {
      inputTokens: 4,
      outputTokens: 3,
      totalTokens: 7,
    });
    await waitFor(async () =>
      (await Promise.all(pids.map(isAlive))).every((alive) => !alive),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  assert.fail('timed out waiting for the fake Codex process tree');
}

async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
