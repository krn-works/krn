import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  gateCheck,
  reviewEvidence,
  writeReviewEvidence,
} from './helpers/ship-evidence.ts';

const taskId = 't-b6v615x';
type MutableReview = {
  [key: string]: unknown;
  judges: Record<string, unknown>[];
};
type Preflight = (
  input: { repo: string; base: string; head: string; pr: number },
  dependencies: Record<string, unknown>,
) => Promise<{ reasons: string[] }>;
const preflightModule = (await import(
  new URL('../scripts/pr-preflight.mjs', import.meta.url).href
)) as unknown as { runPreflight: Preflight };

async function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'krn-preflight-additive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '--quiet', '--initial-branch=main');
  await git(repo, 'config', 'user.name', 'Preflight Test');
  await git(repo, 'config', 'user.email', 'preflight@example.test');
  await git(
    repo,
    'remote',
    'add',
    'origin',
    'https://github.com/krn-works/krn.git',
  );
  await mkdir(join(repo, 'src'));
  await mkdir(join(repo, 'test'));
  await mkdir(join(repo, 'tasks'));
  await writeFile(join(repo, 'src/index.ts'), 'export const value = 1;\n');
  await writeFile(join(repo, 'test/example.test.ts'), 'export {};\n');
  await writeFile(
    join(repo, `tasks/${taskId}.json`),
    `${JSON.stringify(
      {
        id: taskId,
        status: 'open',
        resolution: null,
        created: '2026-10-26',
        priority: 0,
        title: 'Fixture',
        after: [],
        body: [],
      },
      null,
      2,
    )}\n`,
  );
  await git(repo, 'add', '.');
  await git(repo, 'commit', '--quiet', '-m', 'chore: fixture base');
  const base = await git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'src/index.ts'), 'export const value = 2;\n');
  await git(repo, 'add', '.');
  await git(
    repo,
    'commit',
    '--quiet',
    '-m',
    `feat(review): fixture (${taskId})`,
    '-m',
    `Ticket: ${taskId}`,
  );
  const head = await git(repo, 'rev-parse', 'HEAD');
  return { repo, base, head };
}

async function preflight(value: Awaited<ReturnType<typeof fixture>>) {
  const pull = {
    number: 27,
    title: `feat(review): fixture (${taskId})`,
    draft: false,
    state: 'open',
    merged: false,
    merge_commit_sha: null,
    base: {
      sha: value.base,
      ref: 'main',
      repo: { full_name: 'krn-works/krn' },
    },
    head: { sha: value.head, ref: 'fixture' },
  };
  return preflightModule.runPreflight(
    { repo: value.repo, base: value.base, head: value.head, pr: 27 },
    {
      readPull: async () => ({ ok: true, value: pull }),
      readStatuses: async () => ({ ok: true, value: [] }),
      readCheckRuns: async () => ({
        ok: true,
        value: [{ ...gateCheck(), head_sha: value.head }],
      }),
    },
  );
}

test('preflight strips only unknown keys and still refuses invalid or incomplete records', async (t) => {
  const additive = await fixture(t);
  const record = reviewEvidence(additive.base, additive.head) as MutableReview;
  const additiveJudge = record.judges[0];
  assert.ok(additiveJudge);
  additiveJudge.futureField = 'additive';
  record.futureField = { value: 'additive' };
  await writeReviewEvidence(
    additive.repo,
    additive.base,
    additive.head,
    record,
  );
  const accepted = await preflight(additive);
  assert.equal(
    accepted.reasons.some((reason) =>
      reason.includes('review record does not satisfy the strict schema'),
    ),
    false,
    accepted.reasons.join('\n'),
  );

  const invalidEnum = await fixture(t);
  const enumRecord = reviewEvidence(
    invalidEnum.base,
    invalidEnum.head,
  ) as MutableReview;
  const enumJudge = enumRecord.judges[0];
  assert.ok(enumJudge);
  enumJudge.role = 'future-role';
  await writeReviewEvidence(
    invalidEnum.repo,
    invalidEnum.base,
    invalidEnum.head,
    enumRecord,
  );
  const enumRefused = await preflight(invalidEnum);
  assert.ok(
    enumRefused.reasons.some((reason) =>
      reason.includes('review record does not satisfy the strict schema'),
    ),
    enumRefused.reasons.join('\n'),
  );

  const missing = await fixture(t);
  const missingRecord = reviewEvidence(
    missing.base,
    missing.head,
  ) as MutableReview;
  delete missingRecord.headSha;
  missingRecord.futureField = true;
  await writeReviewEvidence(
    missing.repo,
    missing.base,
    missing.head,
    missingRecord,
  );
  const missingRefused = await preflight(missing);
  assert.ok(
    missingRefused.reasons.some((reason) =>
      reason.includes('review record does not satisfy the strict schema'),
    ),
    missingRefused.reasons.join('\n'),
  );
});
