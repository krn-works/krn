import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexHost } from '../src/hosts/codex.ts';
import * as relay from '../src/relay/index.ts';
import * as trace from '../src/trace/index.ts';

async function repoFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'krn-s4b-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q', '--initial-branch=main']);
  await writeFile(join(root, '.gitignore'), '.krn/runs/\n');
  await writeFile(join(root, 'README.md'), 'fixture\n');
  git(['add', '.gitignore', 'README.md']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  return root;
}

async function fakeCodex(root: string, body: string): Promise<string> {
  const path = join(root, 'fake-codex');
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('B1 foreman waits for a checkpointing tool session to die before retrying', async () => {
  const root = await repoFixture();
  const outside = await mkdtemp(join(tmpdir(), 'krn-s4b-shell-'));
  const pidFile = join(outside, 'session-pid');
  const job = { id: 'B1', issue: 'I-1', worktree: root };
  const executable = await fakeCodex(
    outside,
    `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const countFile = ${JSON.stringify(join(outside, 'count'))};
let count = 0; try { count = Number((await import('node:fs')).readFileSync(countFile, 'utf8')); } catch {}
count++; writeFileSync(countFile, String(count));
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'t'+count})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:4,total_tokens:16}})+'\\n');
if (count === 1) {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  let prompt=''; for await (const chunk of process.stdin) prompt += chunk;
  const match = /--session ([0-9a-f-]+)/.exec(prompt); const sid=match[1];
  const args = [${JSON.stringify(new URL('../src/cli/main.ts', import.meta.url).pathname)}, 'checkpoint','--job','B1','--issue','I-1','--worktree',${JSON.stringify(root)},'--intent','intent:0','--session',sid,'--next','step B'];
  const shell = spawn('setsid', ['bash','-c', "node " + args.map((x)=>JSON.stringify(x)).join(' ')], {stdio:'ignore'});
  await new Promise(r=>setTimeout(r, 120000));
} else {
  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n');
}
`,
  );
  const host = new CodexHost({ executable });
  const realRelay = {
    ...relay,
    project: () => 'checkpoint test',
  };
  const { runJob } = await import('../src/foreman/run.ts');
  const cancelled: string[] = [];
  const started: string[] = [];
  try {
    // The fake runs the real CLI inside a distinct shell process group.
    const startedAt = Date.now();
    const outcome = await runJob(job, {
      budget: { maxResets: 1, maxRepairs: 0, session: { timeoutMs: 8_000 } },
      ledger: { readContract: async () => ({ revision: 'r1' }) },
      relay: realRelay,
      trace,
      hosts: {
        codex: {
          start: async (input) => {
            if (started.length)
              assert.ok(
                cancelled.includes(started[0] ?? ''),
                'session 1 must be cancelled before session 2 starts',
              );
            const session = await host.start(input);
            started.push(session.id);
            return session;
          },
        },
        cancelTree: async (id) => {
          cancelled.push(id);
          await host.cancelTree(id);
        },
      },
      stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
    });
    assert.ok(
      Date.now() - startedAt < 7_500,
      'foreman cancellation must beat the host timeout',
    );
    assert.deepEqual(outcome.kind, 'stop');
    const lines = (
      await readFile(join(root, '.krn/runs/foreman/B1.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const ends = lines.filter((event) => event.kind === 'session_ended');
    assert.equal(
      lines.filter((event) => event.kind === 'checkpoint').length,
      1,
    );
    assert.equal(cancelled.includes(started[0] ?? ''), true);
    assert.equal(ends.length, 2);
    assert.equal(ends[0].data.end.usage.totalTokens, 16);
    assert.equal(
      lines.filter((event) => event.kind === 'session_started').length,
      2,
    );
    assert.equal(await isAlive(Number(await readFile(pidFile, 'utf8'))), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('B2 a foreman SIGTERM cancels every detached session group and exits 130', async () => {
  const root = await repoFixture();
  const pidFile = join(root, 'pids');
  const executable = await fakeCodex(
    root,
    `
import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
child.once('spawn',()=>writeFileSync(${JSON.stringify(pidFile)},process.pid+'\\n'+child.pid));
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n'); setInterval(()=>{},1000);
`,
  );
  if (
    typeof (new CodexHost({ executable }) as unknown as { cancelAll?: unknown })
      .cancelAll !== 'function'
  ) {
    await rm(root, { recursive: true, force: true });
    assert.fail(
      'CodexHost.cancelAll is required by the foreman signal handler',
    );
  }
  const live = new URL('../scripts/live-l1.mjs', import.meta.url).pathname;
  const foreman = spawn(
    process.execPath,
    [
      live,
      '--repo',
      root,
      '--job',
      'B2-live',
      '--issue',
      'I-2',
      '--revision',
      'r1',
      '--prompt',
      'hold',
    ],
    {
      cwd: root,
      env: { ...process.env, KRN_LIVE: '1', KRN_CODEX_BIN: executable },
      stdio: 'ignore',
    },
  );
  try {
    await waitFor(async () => {
      try {
        return (await readFile(pidFile, 'utf8')).trim() || undefined;
      } catch {
        return undefined;
      }
    });
    foreman.kill('SIGTERM');
    const code = await new Promise((resolve) => foreman.once('close', resolve));
    assert.equal(code, 130);
    const pids = (await readFile(pidFile, 'utf8'))
      .trim()
      .split('\n')
      .map(Number);
    for (const pid of pids) assert.equal(await isAlive(pid), false);
    await unlink(pidFile);
    const timed = spawn(
      process.execPath,
      [
        live,
        '--repo',
        root,
        '--job',
        'B2-timeout',
        '--issue',
        'I-2',
        '--revision',
        'r1',
        '--prompt',
        'hold',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          KRN_LIVE: '1',
          KRN_CODEX_BIN: executable,
          KRN_LIVE_WALL_TIME_MS: '1500',
        },
        stdio: 'ignore',
      },
    );
    await waitFor(async () => {
      try {
        return (await readFile(pidFile, 'utf8')).trim() || undefined;
      } catch {
        return undefined;
      }
    });
    assert.equal(
      await new Promise((resolve) => timed.once('close', resolve)),
      124,
    );
    for (const pid of (await readFile(pidFile, 'utf8'))
      .trim()
      .split('\n')
      .map(Number))
      assert.equal(await isAlive(pid), false);
  } finally {
    foreman.kill('SIGKILL');
    try {
      for (const pid of (await readFile(pidFile, 'utf8'))
        .trim()
        .split('\n')
        .map(Number))
        process.kill(pid, 'SIGKILL');
    } catch {}
    for (const id of ['B2-live', 'B2-timeout'])
      spawnSync('git', [
        '-C',
        root,
        'worktree',
        'remove',
        '--force',
        join(`${root}-jobs`, id),
      ]);
    await rm(`${root}-jobs`, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('B3 live uses the requested job repo and resumes its supplied worktree', async () => {
  const repo = await repoFixture();
  const bin = await fakeCodex(
    repo,
    `process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n'); process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n');`,
  );
  const fakeHome = await mkdtemp(join(tmpdir(), 'krn-s4b-home-'));
  const defaultCodex = join(
    fakeHome,
    '.codex/packages/app-server-daemon/releases/0.160.0-x86_64-unknown-linux-musl/bin/codex',
  );
  await mkdir(join(defaultCodex, '..'), { recursive: true });
  await copyFile(bin, defaultCodex);
  await chmod(defaultCodex, 0o755);
  const args = [
    '--job',
    'same-job',
    '--issue',
    'I-1',
    '--revision',
    'r1',
    '--prompt',
    'do it',
    '--repo',
    repo,
  ];
  const exec = (extra: string[] = []) =>
    spawnSync('npm', ['run', 'live', '--', ...args, ...extra], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fakeHome,
        KRN_LIVE: '1',
        KRN_CODEX_BIN: bin,
      },
    });
  try {
    const first = exec();
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const job = JSON.parse(lastOutputLine(first.stdout)).job;
    assert.ok(job.worktree.startsWith(`${repo}-jobs/`));
    const resumed = exec(['--worktree', job.worktree]);
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.equal(
      JSON.parse(lastOutputLine(resumed.stdout)).job.worktree,
      job.worktree,
    );
  } finally {
    const packageRoot = new URL('..', import.meta.url).pathname.replace(
      /\/$/,
      '',
    );
    for (const parent of [repo, packageRoot]) {
      const worktree = join(`${parent}-jobs`, 'same-job');
      spawnSync('git', [
        '-C',
        parent,
        'worktree',
        'remove',
        '--force',
        worktree,
      ]);
      await rm(worktree, { recursive: true, force: true });
    }
    await rm(repo, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test('B4 checkpoint preserves worker action and decisions beside lease state', async () => {
  const root = await repoFixture();
  const job = { id: 'B4', issue: 'I-4', worktree: root };
  try {
    const capsule = await relay.load(job, { revision: 'r1' });
    const intent = await trace.intent(job, capsule.epoch);
    const bound = await relay.bindSession(job, capsule, 'session-4');
    assert.equal(bound.applied, true);
    await trace.started(job, intent, 'session-4');
    const cli = new URL('../src/cli/main.ts', import.meta.url).pathname;
    const args = [
      cli,
      'checkpoint',
      '--job',
      job.id,
      '--issue',
      job.issue,
      '--worktree',
      root,
      '--intent',
      intent,
      '--session',
      'session-4',
      '--next',
      'step B: verify',
      '--decision',
      'chose the narrow fix',
    ];
    const saved = await runIsolatedCheckpoint(args);
    assert.equal(saved.code, 0, `${saved.stdout}\n${saved.stderr}`);
    const checkpointed = await relay.load(job, { revision: 'r1' });
    assert.equal(checkpointed.nextAction, 'step B: verify');
    assert.equal(checkpointed.lease, 'checkpointed');
    assert.equal(checkpointed.decisions.at(-1)?.text, 'chose the narrow fix');
    assert.equal(checkpointed.sessionId, 'session-4');
    await writeFile(join(root, 'README.md'), 'dirty after checkpoint\n');
    const dirty = await runIsolatedCheckpoint(args);
    assert.notEqual(dirty.code, 0);
    assert.match(dirty.stderr, /clean working tree/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('B5 trace stores only bounded session metadata and capsule ABI rejects newlines', async () => {
  const root = await repoFixture();
  const job = { id: 'B5', issue: 'I-5', worktree: root };
  const secret = 'MULTILINE FINAL MESSAGE';
  try {
    const intent = await trace.intent(job, 0);
    await trace.started(job, intent, 's5', 1234);
    await trace.log(job, intent, 's5', 'session_ended', {
      reasonKind: 'agent_message',
      reasonSha256: 'a'.repeat(64),
      reasonLength: secret.length,
      claimsDone: true,
      exitCode: 0,
      signal: null,
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      finalMessage: secret,
      stderr: secret,
    } as never);
    const text = await readFile(
      join(root, '.krn/runs/foreman/B5.jsonl'),
      'utf8',
    );
    assert.equal(text.includes(secret), false);
    assert.match(text, /"pgid":1234/);
    assert.match(text, /"sandbox":"workspace-write"/);
    const capsule = await relay.load(job, { revision: 'r1' });
    assert.throws(
      () =>
        relay.writeCapsule(
          job,
          { ...capsule, epoch: 1, nextAction: 'step A\nforged field' },
          0,
        ),
      /single-line/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('B6 parses a multi-megabyte JSONL session under a per-line limit', async () => {
  const root = await repoFixture();
  const executable = await fakeCodex(
    root,
    `
for(let i=0;i<2200;i++) process.stdout.write(JSON.stringify({type:'progress',data:'x'.repeat(1800)})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:91000,output_tokens:12000,total_tokens:103000}})+'\\n');
`,
  );
  const host = new CodexHost({ executable });
  try {
    const session = await host.start({
      cwd: root,
      model: 'gpt-6-luna',
      prompt: 'finish',
      limits: { timeoutMs: 30_000 },
    });
    const end = await session.wait();
    assert.equal(end.claimsDone, true);
    assert.equal(end.usage.totalTokens, 103000);
    assert.equal(end.reasonLength, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('B7 codex command explicitly grants workspace write and only the git common dir', async () => {
  const root = await repoFixture();
  const worktree = join(`${root}-linked`, 'job');
  await mkdir(`${root}-linked`, { recursive: true });
  const added = spawnSync(
    'git',
    ['-C', root, 'worktree', 'add', '--detach', worktree, 'HEAD'],
    { encoding: 'utf8' },
  );
  assert.equal(added.status, 0, added.stderr);
  const argsFile = join(root, 'args');
  const executable = await fakeCodex(
    root,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2))); process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n');`,
  );
  const host = new CodexHost({ executable });
  try {
    const job = { id: 'B7', issue: 'I-7', worktree };
    const intent = await trace.intent(job, 0);
    const session = await host.start({
      cwd: worktree,
      model: 'gpt-6-luna',
      prompt: 'work',
      limits: { timeoutMs: 10_000 },
      onStarted: (id, pgid) => trace.started(job, intent, id, pgid),
    });
    await session.wait();
    const args = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
    assert.deepEqual(
      args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2),
      ['--sandbox', 'workspace-write'],
    );
    assert.deepEqual(
      args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2),
      ['--add-dir', join(root, '.git')],
    );
  } finally {
    await rm(join(worktree, '.krn'), { recursive: true, force: true });
    spawnSync('git', ['-C', root, 'worktree', 'remove', worktree]);
    await rm(`${root}-linked`, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  read: () => Promise<string | undefined>,
): Promise<string> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(20);
  }
  assert.fail('timed out waiting for fake process');
}

async function runIsolatedCheckpoint(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const child = spawn(
    'bash',
    ['-c', `node ${args.map(quote).join(' ')}; code=$?; sleep .05; exit $code`],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) =>
    child.once('close', resolve),
  );
  return { code, stdout, stderr };
}

function lastOutputLine(output: string): string {
  const line = output.trim().split('\n').at(-1);
  assert.ok(line, 'command emitted a JSON result');
  return line;
}
