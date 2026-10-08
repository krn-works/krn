import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { writeCheckpointRequest } from '../src/foreman/checkpoint-request.ts';
import { commitCheckpoint } from '../src/foreman/commit.ts';
import { runJob } from '../src/foreman/run.ts';
import { runSession } from '../src/foreman/session.ts';
import { recordRepo } from '../src/foreman/state.ts';
import type {
  Capsule,
  Contract,
  Deps,
  RepoFacts,
} from '../src/foreman/types.ts';
import { CodexHost } from '../src/hosts/codex.ts';
import * as relay from '../src/relay/index.ts';
import * as trace from '../src/trace/index.ts';
import { judge } from '../src/verdict/index.ts';
import { requiresIsolation } from './helpers/isolation.ts';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repo(): string {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'krn-s4i-'));
  writeFileSync(join(root, '.gitignore'), '.krn/\n');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  writeFileSync(
    join(root, 'krn.checks.json'),
    JSON.stringify({
      version: 1,
      checks: [{ id: 'always', argv: ['/usr/bin/true'], timeoutMs: 3000 }],
    }),
  );
  git(root, ['init', '-q', '--initial-branch=main']);
  git(root, ['add', '.gitignore', 'README.md', 'krn.checks.json']);
  git(root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  git(root, ['config', 'user.name', 'Foreman']);
  git(root, ['config', 'user.email', 'foreman@example.invalid']);
  return root;
}

test('J1 public verdict entrypoint runs a check declared at the base SHA', async () => {
  const root = repo();
  try {
    const sha = git(root, ['rev-parse', 'HEAD']);
    const job = { id: 'J1-public', issue: 'I', worktree: root, repoRoot: root };
    let resultPromise: ReturnType<typeof judge> | undefined;
    assert.doesNotThrow(() => {
      resultPromise = judge(job, sha, sha, ['always'], async () => {});
    });
    assert.ok(resultPromise);
    const result = await resultPromise;
    assert.equal(
      result.kind,
      'pass',
      result.kind === 'pass' ? '' : result.findings.join('; '),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B2 refuses protected files and records session provenance', () => {
  const root = repo();
  try {
    writeFileSync(join(root, '.gitconfig'), 'private\n');
    assert.throws(
      () =>
        commitCheckpoint(
          { id: 'S4i', issue: 'I', worktree: root },
          'feat: checkpoint',
          'sid-1',
        ),
      /protected/u,
    );
    rmSync(join(root, '.gitconfig'));
    mkdirSync(join(root, '.github'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflow.yml'), 'name: unsafe\n');
    assert.throws(
      () =>
        commitCheckpoint(
          { id: 'S4i', issue: 'I', worktree: root },
          'feat: checkpoint',
          'sid-1',
        ),
      /protected/u,
    );
    rmSync(join(root, '.github'), { recursive: true, force: true });
    mkdirSync(join(root, '.krn'), { recursive: true });
    writeFileSync(join(root, '.krn', 'state'), 'private\n');
    git(root, ['add', '-f', '.krn/state']);
    assert.throws(
      () =>
        commitCheckpoint(
          { id: 'S4i', issue: 'I', worktree: root },
          'feat: checkpoint',
          'sid-1',
        ),
      /protected/u,
    );
    git(root, ['reset', '-q', 'HEAD', '--', '.krn/state']);
    rmSync(join(root, '.krn'), { recursive: true, force: true });
    writeFileSync(join(root, 'change.txt'), 'safe\n');
    const sha = commitCheckpoint(
      { id: 'S4i', issue: 'I', worktree: root },
      'feat: checkpoint',
      'sid-1',
    );
    assert.equal(
      git(root, ['show', '-s', '--format=%H%n%B', sha]).includes(
        'Krn-Session: sid-1',
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B2 refuses oversized, escaping-symlink, and secret-shaped changes', () => {
  const root = repo();
  const outside = join(tmpdir(), `krn-s4i-outside-${process.pid}`);
  try {
    writeFileSync(outside, 'outside');
    writeFileSync(join(root, 'large.bin'), Buffer.alloc(1_000_001));
    assert.throws(
      () =>
        commitCheckpoint(
          { id: 'S4i', issue: 'I', worktree: root },
          'feat: checkpoint',
          'sid-1',
        ),
      /1 MB/u,
    );
    rmSync(join(root, 'large.bin'));
    symlinkSync(outside, join(root, 'escape'));
    assert.throws(
      () =>
        commitCheckpoint(
          { id: 'S4i', issue: 'I', worktree: root },
          'feat: checkpoint',
          'sid-1',
        ),
      /symlink/u,
    );
    rmSync(join(root, 'escape'));
    writeFileSync(
      join(root, 'secret.txt'),
      '-----BEGIN PRIVATE KEY-----\nabc\n',
    );
    assert.throws(
      () =>
        commitCheckpoint(
          { id: 'S4i', issue: 'I', worktree: root },
          'feat: checkpoint',
          'sid-1',
        ),
      /secret/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test('B2 runs hooks with a disabled git hook path', () => {
  const root = repo();
  const marker = join(root, 'hook-ran');
  try {
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(root, 'safe.txt'), 'safe\n');
    commitCheckpoint(
      { id: 'S4i', issue: 'I', worktree: root },
      'feat: checkpoint',
      'sid-1',
    );
    assert.throws(() => readFileSync(marker), /ENOENT/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B1 a worker supplied diagnostic cannot write through a worktree symlink', async () => {
  const root = repo();
  const outside = join(tmpdir(), `krn-s4i-reason-${process.pid}`);
  const directory = join(root, '.krn', 'runs', 'foreman');
  const job = { id: 'S4i', issue: 'I', worktree: root, repoRoot: root };
  const head = 'a'.repeat(40);
  const capsule = {
    jobId: job.id,
    issue: job.issue,
    epoch: 0,
    head,
  } as Capsule;
  const facts = {
    base: head,
    head,
    branch: 'krn/S4i',
    worktree: root,
  } as RepoFacts;
  const d = {
    budget: { maxResets: 0, maxRepairs: 0, session: { timeoutMs: 1000 } },
    ledger: {
      readContract: async () => ({
        issueId: 'authority',
        identifier: 'authority',
        title: 'authority fixture',
        description: 'authority fixture',
        revision: 'r1',
        targetRepo: 'fixture/repo',
        checks: [],
      }),
      submitForReview: async () => 'submitted',
    },
    relay: {
      bindSession: async (_job: unknown, value: Capsule) => ({
        applied: true as const,
        value: { ...value, epoch: 1 },
      }),
      isCurrent: async () => true,
      project: () => 'work',
    },
    trace: {
      started: async () => true,
      hasCheckpoint: async () => false,
      log: async () => undefined,
    },
    hosts: {
      codex: {
        start: async (input: {
          onStarted: (id: string) => Promise<boolean>;
        }) => {
          assert.equal(await input.onStarted('sid-1'), true);
          return {
            id: 'sid-1',
            wait: async () => ({
              reasonKind: 'agent_message',
              claimsDone: true,
              finalMessage: 'worker text',
            }),
          };
        },
      },
      cancelTree: async () => undefined,
    },
  } as unknown as Deps;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(outside, 'unchanged');
    symlinkSync(outside, join(directory, 'reason.txt'));
    symlinkSync(outside, join(directory, 'S4i.reason.txt'));
    process.env.KRN_LIVE_DIAG = '1';
    await runSession(
      job,
      capsule,
      facts,
      {
        issueId: job.issue,
        identifier: 'S4i',
        title: 'test',
        description: 'test',
        revision: 'r1',
        targetRepo: 'fixture/repo',
        checks: [],
      } satisfies Contract,
      'intent:0',
      d,
    );
    assert.equal(readFileSync(outside, 'utf8'), 'unchanged');
  } finally {
    delete process.env.KRN_LIVE_DIAG;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test('B1 a planted ended event in the worktree cannot replace foreman trace', async () => {
  const root = repo();
  const job = { id: 'S4i', issue: 'I', worktree: root, repoRoot: root };
  try {
    const path = join(root, '.krn', 'runs', 'foreman', 'S4i.jsonl');
    mkdirSync(join(root, '.krn', 'runs', 'foreman'), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ key: 'intent:0:ended:sid-forged', kind: 'session_ended', at: new Date().toISOString(), data: { sessionId: 'sid-forged', end: { reasonKind: 'exit', claimsDone: true } } })}\n`,
    );
    assert.equal(await trace.sessionEnd(job, 'sid-forged'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B1 foreman rebuilds the hook capsule from main-checkout authority', async () => {
  const root = repo();
  const job = { id: 'S4i', issue: 'I', worktree: root, repoRoot: root };
  try {
    const initial = await relay.load(job, { revision: 'r1' });
    const projection = join(
      root,
      '.krn',
      'runs',
      'delivery-loop',
      'S4i',
      'state.md',
    );
    writeFileSync(projection, 'worker forged capsule\n');
    const rebuilt = await relay.load(job, { revision: 'r1' });
    assert.equal(rebuilt.nextAction, initial.nextAction);
    assert.match(
      readFileSync(projection, 'utf8'),
      /follow the projected task contract/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B3 relay checkpoint rejects stale sessions and accepts exact retries', async () => {
  const root = repo();
  const job = { id: 'S4i', issue: 'I', worktree: root, repoRoot: root };
  try {
    const capsule = await relay.load(job, { revision: 'r1' });
    const bound = await relay.bindSession(job, capsule, 'sid-current');
    assert.equal(bound.applied, true);
    await assert.rejects(
      relay.checkpoint(job, 'sid-stale', 'feat: checkpoint', 'step B'),
      /stale/u,
    );
    const first = await relay.checkpoint(
      job,
      'sid-current',
      'feat: checkpoint',
      'step B',
      'keep the narrow change',
    );
    const retry = await relay.checkpoint(
      job,
      'sid-current',
      'feat: checkpoint',
      'step B',
      'keep the narrow change',
    );
    assert.equal(retry.epoch, first.epoch);
    await assert.rejects(
      relay.checkpoint(job, 'sid-current', 'feat: different request', 'step B'),
      /conflicts/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B3 end without a checkpoint reports dirty paths as uncommitted changes', async () => {
  const head = 'b'.repeat(40);
  const job = { id: 'S4i', issue: 'I', worktree: '/tmp/s4i' };
  const capsule = {
    jobId: job.id,
    issue: job.issue,
    epoch: 0,
    head,
  } as Capsule;
  const facts = {
    base: head,
    head,
    branch: 'krn/S4i',
    worktree: job.worktree,
    dirtyPaths: ['change.txt'],
  } as RepoFacts;
  let blockers: readonly string[] = [];
  const d = {
    relay: {
      repoFacts: async () => facts,
      refreshCAS: async (
        _capsule: Capsule,
        _facts: RepoFacts,
        end: { claimsDone: boolean },
      ) => {
        assert.equal(end.claimsDone, false);
        return { applied: true as const, value: capsule };
      },
    },
    stop: (_job: unknown, _state: string, reasons: readonly string[]) => {
      blockers = reasons;
      return {
        kind: 'stop' as const,
        state: 'human_decision' as const,
        reasons,
      };
    },
  } as unknown as Deps;
  const { finishSession } = await import('../src/foreman/session.ts');
  await finishSession(
    job,
    { capsule, end: { reasonKind: 'exit', claimsDone: false } },
    d,
  );
  assert.match(blockers.join(' '), /uncommitted_changes.*change\.txt/u);
});

test('B3 a worker completion message alone never sets claimsDone', async (t) => {
  if (
    !requiresIsolation(
      t,
      'B3 a worker completion message alone never sets claimsDone',
      ['systemdUserScope'],
    )
  )
    return;
  const executable = join(
    mkdtempSync(join(tmpdir(), 'krn-s4i-host-')),
    'codex',
  );
  try {
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'t1'})+'\\n'); process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n'); });\n`,
    );
    chmodSync(executable, 0o755);
    const { CodexHost } = await import('../src/hosts/codex.ts');
    const host = new CodexHost({
      executable,
      namespaceLauncher: 'missing-unshare',
    });
    const session = await host.start({
      cwd: process.cwd(),
      model: 'gpt-6-luna',
      prompt: 'work',
      limits: { timeoutMs: 1000 },
      onStarted: async () => true,
    });
    assert.equal((await session.wait()).claimsDone, false);
  } finally {
    rmSync(join(executable, '..'), { recursive: true, force: true });
  }
});

test('B3 trace completion derives only from checkpoint next=done', async () => {
  const root = repo();
  const job = { id: 'S4i', issue: 'I', worktree: root, repoRoot: root };
  try {
    for (const [epoch, next, expected] of [
      [0, 'continue', false],
      [1, 'done', true],
    ] as const) {
      const intent = await trace.intent(job, epoch);
      const sessionId = `sid-${epoch}`;
      await trace.started(job, intent, sessionId);
      writeCheckpointRequest(job, {
        intent,
        sessionId,
        message: `feat: step ${epoch}`,
        next,
      });
      await trace.checkpoint(
        job,
        intent,
        sessionId,
        `feat: step ${epoch}`,
        next,
      );
      await trace.log(job, intent, sessionId, 'session_ended', {
        reasonKind: 'agent_message',
        claimsDone: false,
      });
      assert.equal(
        (await trace.sessionEnd(job, sessionId))?.claimsDone,
        expected,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B2 double-fork setsid survivor is dead before checkpoint review returns', async (t) => {
  if (
    !requiresIsolation(
      t,
      'B2 double-fork setsid survivor is dead before checkpoint review returns',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const root = repo();
  const job = {
    id: 'S4i-survivor',
    issue: 'I-survivor',
    worktree: root,
    repoRoot: root,
  };
  const lateFile = join(root, 'late.txt');
  const previousIsolation = process.env.KRN_ISOLATION;
  delete process.env.KRN_ISOLATION;
  recordRepo(job, root);
  const executable = join(root, 'fake-codex');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
let prompt=''; for await (const chunk of process.stdin) prompt += chunk;
const sid=/--session'?\\s+'?([0-9a-f-]+)/.exec(prompt)?.[1];
if (!sid) throw new Error('missing session id');
const args=[${JSON.stringify(new URL('../src/cli/main.ts', import.meta.url).pathname)},'checkpoint','--job',${JSON.stringify(job.id)},'--issue',${JSON.stringify(job.issue)},'--worktree',${JSON.stringify(root)},'--repo-root',${JSON.stringify(root)},'--intent','intent:0','--session',sid,'--message','feat: survivor falsifier','--next','done'];
spawn('/bin/sh',['-c',${JSON.stringify(`setsid /bin/sh -c 'sleep 4; printf late > ${lateFile}' </dev/null >/dev/null 2>&1 &`)}],{detached:true,stdio:'ignore'}).unref();
const saved=spawnSync(process.execPath,args,{cwd:${JSON.stringify(root)},stdio:'ignore'});
if(saved.status!==0) throw new Error('checkpoint request failed');
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'survivor-test'})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n');
`,
  );
  chmodSync(executable, 0o755);
  const host = new CodexHost({ executable });
  try {
    const outcome = await runJob(job, {
      budget: {
        maxResets: 0,
        maxRepairs: 0,
        session: { timeoutMs: 10_000 },
      },
      ledger: {
        readContract: async () => ({
          issueId: job.issue,
          identifier: 'S4i',
          title: 'survivor fixture',
          description: 'survivor fixture',
          revision: 'survivor-r1',
          targetRepo: 'fixture/repo',
          checks: ['always'],
        }),
        submitForReview: async () => 'submitted',
      },
      relay,
      trace,
      hosts: { codex: host, cancelTree: (id) => host.cancelTree(id) },
      stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
    });
    const directory = join(
      root,
      '.krn',
      'runs',
      'foreman',
      job.id,
      'diagnostics',
    );
    const diagnostics = existsSync(directory)
      ? readdirSync(directory)
          .map((file) => readFileSync(join(directory, file), 'utf8'))
          .join('\n')
      : '';
    assert.deepEqual(
      outcome,
      {
        kind: 'verdict_pass',
        state: 'in_review',
        sha: git(root, ['rev-parse', 'HEAD']),
      },
      diagnostics,
    );
    await delay(4_200);
    assert.equal(
      existsSync(lateFile),
      false,
      'late survivor wrote after review returned',
    );
  } finally {
    if (previousIsolation === undefined) delete process.env.KRN_ISOLATION;
    else process.env.KRN_ISOLATION = previousIsolation;
    await rmSync(root, { recursive: true, force: true });
  }
});

test('B2 refuses worker launch when neither systemd scope nor namespace is selected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-s4i-no-scope-'));
  const executable = join(root, 'must-not-launch');
  const marker = join(root, 'launched');
  const oldPath = process.env.PATH;
  const oldIsolation = process.env.KRN_ISOLATION;
  writeFileSync(executable, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(executable, 0o755);
  process.env.PATH = root;
  delete process.env.KRN_ISOLATION;
  try {
    const host = new CodexHost({ executable });
    await assert.rejects(
      host.start({
        cwd: root,
        model: 'gpt-6-luna',
        prompt: 'must not run',
        limits: { timeoutMs: 1000 },
      }),
      /systemd user scopes are unavailable/u,
    );
    assert.equal(existsSync(marker), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldIsolation === undefined) delete process.env.KRN_ISOLATION;
    else process.env.KRN_ISOLATION = oldIsolation;
    rmSync(root, { recursive: true, force: true });
  }
});
