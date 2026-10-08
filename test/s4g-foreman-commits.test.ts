import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runJob } from '../src/foreman/run.ts';
import { CodexHost } from '../src/hosts/codex.ts';
import * as relay from '../src/relay/index.ts';
import * as trace from '../src/trace/index.ts';
import { requiresIsolation } from './helpers/isolation.ts';

async function fixture(options: {
  readonly edit: boolean;
  readonly editAfter?: boolean;
  readonly next: string;
}) {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'krn-s4g-'));
  const auxiliary = await mkdtemp(join(tmpdir(), 'krn-s4g-worker-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '--initial-branch=main']);
  await writeFile(join(root, '.gitignore'), '.krn/\n');
  await writeFile(join(root, 'README.md'), 'fixture\n');
  await writeFile(
    join(root, 'krn.checks.json'),
    JSON.stringify({
      version: 1,
      checks: [{ id: 'always', argv: ['/usr/bin/true'], timeoutMs: 3000 }],
    }),
  );
  git(['add', '.gitignore', 'README.md', 'krn.checks.json']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  git(['config', 'user.name', 'Foreman']);
  git(['config', 'user.email', 'foreman@example.invalid']);
  const fake = join(auxiliary, 'fake-codex.mjs');
  await writeFile(
    fake,
    `#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
let prompt=''; for await (const chunk of process.stdin) prompt += chunk;
const root=${JSON.stringify(root)};
const cli=${JSON.stringify(new URL('../src/cli/main.ts', import.meta.url).pathname)};
const countPath=${JSON.stringify(join(auxiliary, 'calls'))};
let count=0; try { count=Number(readFileSync(countPath,'utf8')); } catch {}
count++; writeFileSync(countPath,String(count));
const sid=/--session'?\\s+'?([0-9a-f-]+)/.exec(prompt)?.[1];
if(!sid) throw new Error('bound session id was not printed');
if(count===1 && ${options.edit}) writeFileSync(${JSON.stringify(join(root, 'change.txt'))},'worker edit\\n');
if(count===1) {
 const workerAttempt=spawnSync('git',['-C',root,'commit','--allow-empty','-m','worker attempt'],{encoding:'utf8',env:{...process.env,GIT_INDEX_FILE:${JSON.stringify(join(auxiliary, 'worker-read-only', 'index'))}}});
 appendFileSync(${JSON.stringify(join(auxiliary, 'worker-git-attempt'))},String(workerAttempt.status));
 execFileSync(process.execPath,[cli,'checkpoint','--job','S4g','--issue','S4g','--worktree',root,'--intent','intent:0','--session',sid,'--message','feat: save worker step','--next',${JSON.stringify(options.next)}],{cwd:root});
 if(${options.editAfter ?? false}) writeFileSync(${JSON.stringify(join(root, 'change.txt'))},'worker edit after request\\n');
}
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'fake-'+count})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:count===1?'checkpoint recorded':'finished'}})+'\\n');
`,
  );
  await chmod(fake, 0o755);
  const host = new CodexHost({ executable: fake });
  const job = { id: 'S4g', issue: 'S4g', worktree: root };
  const outcome = await runJob(job, {
    budget: { maxResets: 1, maxRepairs: 0, session: { timeoutMs: 10_000 } },
    ledger: {
      readContract: async () => ({
        issueId: job.issue,
        identifier: 'S4g',
        title: 'commit fixture',
        description: 'commit fixture',
        revision: 'r1',
        targetRepo: 'fixture/repo',
        checks: ['always'],
      }),
      submitForReview: async () => 'submitted',
    },
    relay,
    trace,
    hosts: {
      codex: { start: (input) => host.start(input) },
      cancelTree: (id) => host.cancelTree(id),
    },
    stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
  });
  return { root, auxiliary, outcome };
}

test('real CLI records a dirty checkpoint and foreman commits it for the bound session', async (t) => {
  if (
    !requiresIsolation(
      t,
      'real CLI records a dirty checkpoint and foreman commits it for the bound session',
      ['systemdUserScope'],
    )
  )
    return;
  const { root, auxiliary, outcome } = await fixture({
    edit: true,
    next: 'step B',
  });
  try {
    assert.equal(
      spawnSync('git', ['-C', root, 'log', '-1', '--format=%s'], {
        encoding: 'utf8',
      }).stdout.trim(),
      'feat: save worker step',
    );
    const events = (
      await readFile(join(root, '.krn/runs/foreman/S4g/trace.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const checkpoint = events.find((event) => event.kind === 'checkpoint');
    const commit = events.find((event) => event.kind === 'commit');
    assert.equal(commit.data.sessionId, checkpoint.data.sessionId);
    assert.equal(
      commit.data.sha,
      spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).stdout.trim(),
    );
    const capsule = await relay.load(
      { id: 'S4g', issue: 'S4g', worktree: root },
      { revision: 'r1' },
    );
    assert.equal(
      capsule.decisions.some(
        (decision) =>
          decision.source === checkpoint.data.sessionId &&
          decision.text.includes(commit.data.sha),
      ),
      true,
    );
    assert.equal(await readFile(join(auxiliary, 'calls'), 'utf8'), '2');
    assert.equal(outcome.kind, 'stop');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(auxiliary, { recursive: true, force: true });
  }
});

test('checkpoint CLI records its request when git execution is forbidden', async () => {
  const { root, auxiliary } = await fixture({ edit: true, next: 'done' });
  const gitShim = join(auxiliary, 'git');
  try {
    await writeFile(
      gitShim,
      '#!/bin/sh\nprintf "spawnSync git EPERM\\n" >&2\nexit 1\n',
    );
    await chmod(gitShim, 0o755);
    const sid = 'sandbox-session-1';
    const job = { id: 'S4h', issue: 'S4h', worktree: root };
    await relay.bindSession(
      job,
      await relay.load(job, { revision: 'r1' }),
      sid,
    );
    await trace.started(job, 'intent:0', sid);
    const request = spawnSync(
      process.execPath,
      [
        new URL('../src/cli/main.ts', import.meta.url).pathname,
        'checkpoint',
        '--job',
        'S4h',
        '--issue',
        'S4h',
        '--worktree',
        root,
        '--intent',
        'intent:0',
        '--session',
        sid,
        '--message',
        'feat: save worker step',
        '--next',
        'done',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: auxiliary },
      },
    );

    assert.equal(request.status, 0, request.stderr);
    assert.deepEqual(await trace.checkpointRequest(job, 'intent:0', sid), {
      message: 'feat: save worker step',
      next: 'done',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(auxiliary, { recursive: true, force: true });
  }
});

test('foreman commits even when the worker git commit attempt fails', async (t) => {
  if (
    !requiresIsolation(
      t,
      'foreman commits even when the worker git commit attempt fails',
      ['systemdUserScope'],
    )
  )
    return;
  const { root, auxiliary } = await fixture({ edit: true, next: 'done' });
  try {
    assert.notEqual(
      await readFile(join(auxiliary, 'worker-git-attempt'), 'utf8'),
      '0',
    );
    assert.equal(
      spawnSync('git', ['-C', root, 'log', '-1', '--format=%s'], {
        encoding: 'utf8',
      }).stdout.trim(),
      'feat: save worker step',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(auxiliary, { recursive: true, force: true });
  }
});

test('checkpoint with no worktree changes is refused without a commit', async (t) => {
  if (
    !requiresIsolation(
      t,
      'checkpoint with no worktree changes is refused without a commit',
      ['systemdUserScope'],
    )
  )
    return;
  const { root, auxiliary, outcome } = await fixture({
    edit: false,
    next: 'step B',
  });
  try {
    assert.equal(outcome.kind, 'stop');
    assert.match(outcome.reasons.join(' '), /no changes to commit/u);
    assert.equal(
      spawnSync('git', ['-C', root, 'log', '-1', '--format=%s'], {
        encoding: 'utf8',
      }).stdout.trim(),
      'fixture',
    );
    assert.equal(await readFile(join(auxiliary, 'calls'), 'utf8'), '1');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(auxiliary, { recursive: true, force: true });
  }
});

test('real CLI --next done records a verdict without opening another session', async (t) => {
  if (
    !requiresIsolation(
      t,
      'real CLI --next done records a verdict without opening another session',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const { root, auxiliary, outcome } = await fixture({
    edit: false,
    editAfter: true,
    next: 'done',
  });
  try {
    const diagPath = join(
      root,
      '.krn',
      'runs',
      'foreman',
      'S4g',
      'diagnostics',
    );
    const diagnostics = await readdir(diagPath)
      .then((files) =>
        Promise.all(
          files.map((file) => readFile(join(diagPath, file), 'utf8')),
        ),
      )
      .then((files) => files.join('\n'))
      .catch(() => '');
    assert.deepEqual(
      outcome,
      {
        kind: 'verdict_pass',
        state: 'in_review',
        sha: spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).stdout.trim(),
      },
      diagnostics,
    );
    assert.equal(await readFile(join(auxiliary, 'calls'), 'utf8'), '1');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(auxiliary, { recursive: true, force: true });
  }
});
