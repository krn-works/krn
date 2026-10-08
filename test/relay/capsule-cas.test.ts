import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as relay from '../../src/relay/index.ts';
import * as trace from '../../src/trace/index.ts';

const validator =
  '/mnt/storage/coding/krn/active/krn-codex-skills/scripts/krn.mjs';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('a capsule write from a stale epoch is rejected', async () => {
  const writeCapsule = Reflect.get(relay, 'writeCapsule') as
    | ((
        job: unknown,
        capsule: unknown,
        expectedEpoch: number | null,
      ) => Promise<unknown>)
    | undefined;
  if (typeof writeCapsule !== 'function')
    assert.fail('relay exposes capsule CAS writes');

  const worktree = await mkdtemp(join(tmpdir(), 'krn-relay-'));
  const job = { id: 'E1-04', issue: 'issue-1', worktree, repoRoot: worktree };
  const capsule = {
    jobId: job.id,
    issue: job.issue,
    contractRevision: 'rev-1',
    epoch: 0,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    branch: 'feat/s3-relay',
    worktree,
    nextAction: 'resume implementation',
    lease: 'ended' as const,
    blockers: [],
    decisions: [],
    rejectedApproaches: [],
    references: [],
  };

  try {
    git(worktree, ['init', '-q', '--initial-branch=main']);
    await writeFile(join(worktree, '.gitignore'), '.krn/\n');
    git(worktree, ['add', '.gitignore']);
    git(worktree, [
      '-c',
      'user.name=Relay Test',
      '-c',
      'user.email=relay@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    assert.deepEqual(await writeCapsule(job, capsule, null), {
      applied: true,
      value: capsule,
    });
    const statePath = join(
      worktree,
      '.krn',
      'runs',
      'delivery-loop',
      job.id,
      'state.md',
    );
    const state = await readFile(statePath, 'utf8');
    assert.match(state, /^Outcome and observable acceptance:/m);
    assert.deepEqual(await relay.load(job, { revision: 'rev-1' }), capsule);
    const lonDescription = `Follow-up from Luna judges on #366 (non-blocking). Step A: docs/adr/0010-claude-orchestrates-codex-implements.md line 6 lists 'Claude Code lead sessions' as consumer; the lead is swappable across harnesses (Claude Opus or Codex gpt-6.1-sol) per the #366 amendment -> state 'lead sessions across harnesses'. Check: node --test test/rules/instruction-ownership.test.mjs. Step B: CONTEXT.md line ~25 summary still says Claude leads and Codex workers implement -> align with ADR 0010 amendment (workers and judges gpt-6-luna; Sol only on operator request; lead harness-neutral). Check: npm run validate:remaining. Used as the first live krn J1 run (L1): no board writes by the worker; PR via the normal lead loop afterwards.\n\n\`\`\`krn-contract\n{"version":1,"targetRepo":"krn-works/krn-codex-skills","checks":["instruction-ownership","validate-remaining","skills-check"]}\n\`\`\``;
    const taskContract = {
      issueId: 'issue-1',
      identifier: 'LON-200',
      title:
        'docs: describe the lead as harness-neutral in ADR 0010 and CONTEXT',
      description: lonDescription,
      revision: 'rev-1',
      targetRepo: 'krn-works/krn-codex-skills',
      checks: ['instruction-ownership', 'validate-remaining', 'skills-check'],
    };
    const brief = relay.project(
      capsule,
      {
        base: capsule.base,
        head: capsule.head,
        branch: capsule.branch,
        worktree,
      },
      taskContract,
    );
    assert.match(brief, /Task contract:/u);
    assert.match(brief, /LON-200/u);
    assert.match(brief, /docs: describe the lead as harness-neutral/u);
    assert.ok(brief.includes(lonDescription));
    assert.doesNotMatch(brief, /description truncated/u);
    assert.match(
      brief,
      /instruction-ownership, validate-remaining, skills-check/u,
    );
    assert.match(
      brief,
      /This contract is your task source; do not look for tasks elsewhere\./u,
    );
    const longBrief = relay.project(
      capsule,
      {
        base: capsule.base,
        head: capsule.head,
        branch: capsule.branch,
        worktree,
      },
      {
        ...taskContract,
        description: 'x'.repeat(12000),
      },
    );
    assert.ok(longBrief.length > 2000);
    assert.ok(Math.ceil(longBrief.length / 4) <= 2000);
    assert.match(
      longBrief,
      /\[description truncated to fit the 2k-token projection budget\]/u,
    );
    await assert.rejects(
      relay.load(job, { revision: 'rev-2' }),
      /contract revision is stale/u,
    );
    assert.deepEqual(await writeCapsule(job, { ...capsule, epoch: 1 }, -1), {
      applied: false,
    });
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test('the existing state checker accepts a capsule session id as evidence', async () => {
  assert.ok(
    existsSync(validator),
    `capsule ABI validator is available at ${validator}`,
  );
  const worktree = await mkdtemp(join(tmpdir(), 'krn-relay-validator-'));
  const job = { id: 'E1-04', issue: 'issue-1', worktree, repoRoot: worktree };
  try {
    git(worktree, ['init', '-q', '--initial-branch=main']);
    await Promise.all([
      writeFile(join(worktree, '.gitignore'), '.krn/runs/\n'),
      writeFile(join(worktree, 'README.md'), 'validator fixture\n'),
    ]);
    git(worktree, ['add', '.gitignore', 'README.md']);
    git(worktree, [
      '-c',
      'user.name=Relay Test',
      '-c',
      'user.email=relay@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    const capsule = await relay.load(job, { revision: 'rev-1' });
    await trace.intent(job, capsule.epoch);
    const resumed = { ...capsule, epoch: 1, sessionId: 'session-opaque-42' };
    assert.deepEqual(await relay.writeCapsule(job, resumed, 0), {
      applied: true,
      value: resumed,
    });
    assert.deepEqual(await relay.load(job, { revision: 'rev-1' }), resumed);
    const state = await readFile(
      join(worktree, '.krn', 'runs', 'delivery-loop', job.id, 'state.md'),
      'utf8',
    );
    assert.match(state, /^Restart state: ABSENT$/m);
    assert.match(
      state,
      /^Evidence observed: session="session-opaque-42"; lease=ended$/m,
    );

    const checked = spawnSync(
      process.execPath,
      [validator, 'state', 'check', '--root', worktree, '--json'],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
    assert.equal(JSON.parse(checked.stdout).status, 'clean');
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});
