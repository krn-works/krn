import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runJob } from '../../src/foreman/run.ts';
import { runSession } from '../../src/foreman/session.ts';
import type { Capsule, Contract, Deps } from '../../src/foreman/types.ts';
import * as relay from '../../src/relay/index.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const cli = new URL('../../src/cli/main.ts', import.meta.url).pathname;

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('checkpoint instruction is imperative and its filled command executes', async (t) => {
  if (
    !requiresIsolation(
      t,
      'checkpoint instruction is imperative and its filled command executes',
      ['systemdUserScope'],
    )
  )
    return;
  const root = mkdtempSync(join(tmpdir(), 'krn-s4e-checkpoint-'));
  const executable = join(root, 'fake-codex');
  const argsPath = join(root, '.krn', 'args.json');
  try {
    mkdirSync(join(root, '.krn'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '.krn/\nfake-codex\n');
    writeFileSync(join(root, 'README.md'), 'checkpoint fixture\n');
    git(root, ['init', '-q', '--initial-branch=main']);
    git(root, ['add', '.gitignore', 'README.md']);
    git(root, [
      '-c',
      'user.name=KRN Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nconst data = await new Promise((resolve) => { let value = ''; process.stdin.setEncoding('utf8').on('data', (part) => value += part).on('end', () => resolve(value)); });\nwriteFileSync(${JSON.stringify(join(root, '.krn', 'prompt.txt'))}, data);\nwriteFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    git(root, ['config', 'user.name', 'KRN Test']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    const { chmodSync } = await import('node:fs');
    chmodSync(executable, 0o755);
    const { CodexHost } = await import('../../src/hosts/codex.ts');
    const host = new CodexHost({
      executable,
      namespaceLauncher: 'missing-unshare',
    });
    const job = { id: 'J1', issue: 'issue-1', worktree: root };
    let startedSession = '';
    const run = await host.start({
      cwd: root,
      model: 'gpt-6-luna',
      prompt: 'work',
      limits: { timeoutMs: 5000 },
      checkpoint: {
        cli,
        job: job.id,
        issue: job.issue,
        worktree: root,
        intent: 'intent:0',
        message: 'feat: save step one',
        next: 'continue with step two',
      },
      onStarted: async (session) => {
        startedSession = session;
        const capsule = await relay.load(job, { revision: 'r1' });
        const bound = await relay.bindSession(job, capsule, session);
        assert.equal(bound.applied, true);
        const { intent, started } = await import('../../src/trace/index.ts');
        const intentId = await intent(job, 0);
        assert.equal(intentId, 'intent:0');
        assert.equal(await started(job, intentId, session), true);
        return true;
      },
    });
    await run.wait();
    const codexArgs = JSON.parse(readFileSync(argsPath, 'utf8')) as string[];
    assert.deepEqual(
      codexArgs.slice(
        codexArgs.indexOf('--add-dir'),
        codexArgs.indexOf('--add-dir') + 2,
      ),
      ['--add-dir', join(root, '.krn')],
    );
    const prompt = readFileSync(join(root, '.krn', 'prompt.txt'), 'utf8');
    assert.match(
      prompt,
      /Execute this exact command in your terminal now, then end your turn\. Do not write the command as a text response:/u,
    );
    const match =
      /Execute this exact command in your terminal now, then end your turn\. Do not write the command as a text response:\n([^\n]+)/u.exec(
        prompt,
      );
    const printedCommand = match?.[1];
    assert.ok(
      printedCommand,
      'prompt contains one executable checkpoint command',
    );
    assert.match(printedCommand, /--job/u);
    assert.match(printedCommand, /--issue/u);
    assert.match(printedCommand, /--worktree/u);
    assert.match(printedCommand, /--intent/u);
    assert.match(printedCommand, /--session/u);
    assert.match(printedCommand, /--message 'feat: save step one'/u);
    assert.match(printedCommand, /--next 'continue with step two'/u);
    assert.equal(prompt.trimEnd().split('\n').at(-1), printedCommand);
    assert.equal(
      git(root, ['status', '--porcelain', '--untracked-files=normal']),
      '',
    );
    const result = spawnSync('/bin/sh', ['-lc', printedCommand], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const { checkpointRequest } = await import('../../src/trace/index.ts');
    assert.deepEqual(await checkpointRequest(job, 'intent:0', startedSession), {
      message: 'feat: save step one',
      next: 'continue with step two',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('relay references only files present in the target repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-s4e-refs-'));
  try {
    mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'local rules\n');
    writeFileSync(join(root, 'CONTEXT.md'), 'local context\n');
    writeFileSync(
      join(root, 'docs', 'adr', '0002-local.md'),
      'local decision\n',
    );
    git(root, ['init', '-q', '--initial-branch=main']);
    git(root, ['add', 'AGENTS.md', 'CONTEXT.md', 'docs/adr/0002-local.md']);
    git(root, [
      '-c',
      'user.name=KRN Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    const capsule = await relay.load(
      { id: 'J2', issue: 'issue-2', worktree: root },
      { revision: 'r1' },
    );
    assert.deepEqual(capsule.references, [
      'AGENTS.md',
      'CONTEXT.md',
      'docs/adr/0002-local.md',
    ]);
    assert.ok(!capsule.references.includes('docs/adr/0001-product-krn.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('krn start creates a named krn/<job-id> branch', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-s4e-start-'));
  try {
    writeFileSync(join(root, '.gitignore'), '.krn/worktrees/\n');
    writeFileSync(join(root, 'README.md'), 'start fixture\n');
    git(root, ['init', '-q', '--initial-branch=main']);
    git(root, ['add', '.gitignore', 'README.md']);
    git(root, [
      '-c',
      'user.name=KRN Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    const result = spawnSync(
      process.execPath,
      [cli, 'start', '--job', 'J3', '--issue', 'issue-3'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const job = JSON.parse(result.stdout) as {
      worktree: string;
      repoRoot: string;
    };
    assert.equal(git(job.worktree, ['branch', '--show-current']), 'krn/J3');
    assert.equal(job.repoRoot, root);
    const record = JSON.parse(
      readFileSync(join(root, '.krn/runs/foreman/J3/repo.json'), 'utf8'),
    ) as { gitDir: string; gitWorkTree: string };
    assert.equal(record.gitWorkTree, job.worktree);
    assert.match(record.gitDir, /\.git/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('foreman reports no_progress when a claimed-complete session has no checkpoint or HEAD change', async () => {
  const head = 'a'.repeat(40);
  const job = { id: 'J4', issue: 'issue-4', worktree: '/tmp/j4' };
  const capsule = {
    jobId: job.id,
    issue: job.issue,
    epoch: 0,
    head,
  } as Capsule;
  const facts = { base: head, head, branch: 'krn/J4', worktree: job.worktree };
  const d = {
    budget: { maxResets: 0, maxRepairs: 0, session: { timeoutMs: 1000 } },
    ledger: {
      readContract: async () => ({
        issueId: 'progress',
        identifier: 'progress',
        title: 'progress fixture',
        description: 'progress fixture',
        revision: 'r1',
        targetRepo: 'fixture/repo',
        checks: [],
      }),
    },
    relay: {
      load: async () => capsule,
      checkpoint: async () => capsule,
      bindSession: async (_job: unknown, value: Capsule) => ({
        applied: true as const,
        value: { ...value, epoch: 1 },
      }),
      isCurrent: async () => true,
      repoFacts: async () => facts,
      validate: () => ({ ok: true as const }),
      project: () => 'work',
      refreshCAS: async () => ({ applied: true as const, value: capsule }),
    },
    trace: {
      intent: async () => 'intent:0',
      started: async () => true,
      checkpoint: async () => undefined,
      hasCheckpoint: async () => false,
      sessionEnd: async () => null,
      log: async () => undefined,
      failure: async () => undefined,
    },
    hosts: {
      codex: {
        start: async (input: {
          onStarted: (id: string) => Promise<boolean>;
        }) => {
          assert.equal(await input.onStarted('session-1'), true);
          return {
            id: 'session-1',
            wait: async () => ({
              reasonKind: 'agent_message',
              claimsDone: true,
            }),
          };
        },
      },
      cancelTree: async () => undefined,
    },
    stop: (
      _job: unknown,
      state: 'human_decision',
      reasons: readonly string[],
    ) => ({ kind: 'stop' as const, state, reasons }),
  } as unknown as Deps;

  assert.deepEqual(await runJob(job, d), {
    kind: 'stop',
    state: 'human_decision',
    reasons: ['no_progress'],
  });
});

test('KRN_LIVE_DIAG stores only an opt-in, 2000-character reason file outside trace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-s4e-diag-'));
  git(root, ['init', '-q', '--initial-branch=main']);
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, [
    '-c',
    'user.name=KRN Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const job = { id: 'J5', issue: 'issue-5', worktree: root, repoRoot: root };
  const head = 'b'.repeat(40);
  const capsule = {
    jobId: job.id,
    issue: job.issue,
    epoch: 1,
    head,
  } as Capsule;
  const facts = { base: head, head, branch: 'krn/J5', worktree: root };
  const message = 'x'.repeat(2200);
  let logged = '';
  const d = {
    budget: { maxResets: 0, maxRepairs: 0, session: { timeoutMs: 1000 } },
    ledger: {
      readContract: async () => ({
        issueId: 'progress',
        identifier: 'progress',
        title: 'progress fixture',
        description: 'progress fixture',
        revision: 'r1',
        targetRepo: 'fixture/repo',
        checks: [],
      }),
    },
    relay: {
      load: async () => capsule,
      checkpoint: async () => capsule,
      bindSession: async (_job: unknown, value: Capsule) => ({
        applied: true as const,
        value: { ...value, epoch: 2 },
      }),
      isCurrent: async () => true,
      repoFacts: async () => facts,
      validate: () => ({ ok: true as const }),
      project: () => 'work',
      refreshCAS: async () => ({ applied: true as const, value: capsule }),
    },
    trace: {
      intent: async () => 'intent:0',
      started: async () => true,
      checkpoint: async () => undefined,
      hasCheckpoint: async () => false,
      sessionEnd: async () => null,
      log: async (
        _job: unknown,
        _intent: string,
        _session: string,
        _event: string,
        end: unknown,
      ) => {
        logged = JSON.stringify(end);
      },
      failure: async () => undefined,
    },
    hosts: {
      codex: {
        start: async (input: {
          onStarted: (id: string) => Promise<boolean>;
        }) => {
          assert.equal(await input.onStarted('session-2'), true);
          return {
            id: 'session-2',
            wait: async () => ({
              reasonKind: 'agent_message',
              claimsDone: true,
              finalMessage: message,
            }),
          };
        },
      },
      cancelTree: async () => undefined,
    },
    stop: () => ({
      kind: 'stop' as const,
      state: 'human_decision' as const,
      reasons: [],
    }),
  } as unknown as Deps;

  const path = join(root, '.krn', 'runs', 'foreman', 'J5', 'reason.txt');
  const previous = process.env.KRN_LIVE_DIAG;
  try {
    delete process.env.KRN_LIVE_DIAG;
    await runSession(
      job,
      capsule,
      facts,
      {
        issueId: job.issue,
        identifier: 'J5',
        title: 'test',
        description: 'test',
        revision: 'r1',
        targetRepo: 'fixture/repo',
        checks: [],
      } satisfies Contract,
      'intent:0',
      d,
    );
    assert.equal(existsSync(path), false);
    process.env.KRN_LIVE_DIAG = '1';
    await runSession(
      job,
      capsule,
      facts,
      {
        issueId: job.issue,
        identifier: 'J5',
        title: 'test',
        description: 'test',
        revision: 'r1',
        targetRepo: 'fixture/repo',
        checks: [],
      } satisfies Contract,
      'intent:0',
      d,
    );
    assert.equal(readFileSync(path, 'utf8'), message.slice(0, 2000));
    assert.ok(!logged.includes('finalMessage'));
    assert.ok(!logged.includes(message.slice(0, 30)));
  } finally {
    if (previous === undefined) delete process.env.KRN_LIVE_DIAG;
    else process.env.KRN_LIVE_DIAG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
