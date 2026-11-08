import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { judgeRole } from '../../src/flow/panel.ts';
import { CodexHost } from '../../src/hosts/codex.ts';
import { requiresIsolation } from '../helpers/isolation.ts';
import { capture } from '../receivers/capture.ts';

// KRN-12: codex 0.167.0 `exec --json` judge turns (test/fixtures/codex-cli-0.167.0).
// The stand-in drains stdin, then replays the captured stdout and exit code.
const pass = capture('fixtures/codex-cli-0.167.0', 'exec-pass');
const invalid = capture('fixtures/codex-cli-0.167.0', 'exec-invalid-verdict');

async function scratch(name: string) {
  const parent = join(process.cwd(), '.krn', 'tmp');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, `${name}-`));
}

async function standIn(root: string, recorded: typeof pass): Promise<string> {
  const stdout = join(root, 'stdout.jsonl');
  await writeFile(stdout, recorded.streams.stdout ?? Buffer.alloc(0));
  const executable = join(root, 'codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nawait new Promise((done) => { process.stdin.on('end', done); process.stdin.resume(); });\nprocess.stdout.write(readFileSync(${JSON.stringify(stdout)}));\nprocess.exitCode = ${recorded.exitCode};\n`,
    { mode: 0o755 },
  );
  return executable;
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('CodexHost reads the captured judge turn: thread, final message and usage', async (t) => {
  if (!requiresIsolation(t, 'Codex exec capture', ['systemdUserScope'])) return;
  const root = await scratch('codex-exec-capture');
  const host = new CodexHost({
    executable: await standIn(root, pass),
    drainQuietMs: 100,
  });
  try {
    git(root, 'init', '-q');
    const session = await host.start({
      cwd: root,
      model: 'gpt-6-luna',
      prompt: 'captured judge turn',
      limits: { timeoutMs: 5000 },
    });
    const result = await session.wait();
    assert.equal(result.exitCode, 0);
    assert.equal(result.threadId, '01a1bb0d-2913-7db1-8a68-681c3ee3bf7e');
    assert.equal(result.claimsDone, true);
    assert.equal(result.finalMessage, '{"verdict":"PASS","findings":[]}');
    assert.deepEqual(result.usage, {
      inputTokens: 37671,
      cachedInputTokens: 22784,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
      outputTokens: 73,
      totalTokens: 37744,
    });
  } finally {
    try {
      await host.cancelAll();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('the panel accepts the captured PASS and rejects the captured FAIL without findings', async (t) => {
  if (!requiresIsolation(t, 'Panel exec capture', ['systemdUserScope'])) return;
  const root = await scratch('panel-exec-capture');
  try {
    const repo = join(root, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-q');
    await writeFile(join(repo, 'one.ts'), 'export const one = 1;\n');
    git(repo, 'add', '.');
    git(
      repo,
      '-c',
      'user.name=f',
      '-c',
      'user.email=f@example.invalid',
      'commit',
      '-qm',
      'one',
    );
    const head = git(repo, 'rev-parse', 'HEAD');
    const judge = async (recorded: typeof pass, name: string) => {
      const dir = join(root, name);
      await mkdir(dir);
      return judgeRole({
        root: repo,
        base: head,
        head,
        role: 'adversarial',
        lens: 'one.ts exports 1',
        timeoutMs: 5000,
        executable: await standIn(dir, recorded),
      });
    };
    assert.deepEqual(await judge(pass, 'pass'), {
      state: 'complete',
      role: 'adversarial',
      verdict: 'PASS',
      findings: [],
    });
    assert.deepEqual(await judge(invalid, 'invalid'), {
      state: 'incomplete',
      role: 'adversarial',
      reason: 'invalid_verdict',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
