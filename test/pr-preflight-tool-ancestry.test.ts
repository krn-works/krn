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

const taskId = 't-tmptv5f';
type MutableReview = {
  [key: string]: unknown;
  judges: Record<string, unknown>[];
};
type Preflight = (
  input: { repo: string; base: string; head: string; pr: number },
  dependencies: Record<string, unknown>,
) => Promise<{ reasons: string[]; verdict: 'pass' | 'fail' }>;
const preflightModule = (await import(
  new URL('../scripts/pr-preflight.mjs', import.meta.url).href
)) as unknown as { runPreflight: Preflight };

async function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'krn-preflight-tool-ancestry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'test'));
  await mkdir(join(repo, 'tasks'));
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
  await git(repo, 'commit', '--quiet', '-m', 'chore: fixture root');
  const ancestor = await git(repo, 'rev-parse', 'HEAD');

  await writeFile(join(repo, 'base.txt'), 'base\n');
  await git(repo, 'add', 'base.txt');
  await git(repo, 'commit', '--quiet', '-m', 'chore: fixture PR base');
  const base = await git(repo, 'rev-parse', 'HEAD');

  await writeFile(join(repo, 'src/index.ts'), 'export const value = 2;\n');
  await git(repo, 'add', 'src/index.ts');
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
  return { repo, ancestor, base, head };
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

async function recordReasons(
  t: test.TestContext,
  toolSha: (value: Awaited<ReturnType<typeof fixture>>) => string,
  invalidSchema = false,
) {
  const value = await fixture(t);
  const record = reviewEvidence(value.base, value.head) as MutableReview;
  record.toolSha = toolSha(value);
  if (invalidSchema) {
    const judge = record.judges[0];
    assert.ok(judge);
    judge.role = 'future-role';
  }
  await writeReviewEvidence(value.repo, value.base, value.head, record);
  return { value, reasons: (await preflight(value)).reasons };
}

function reviewerReason(toolSha: string, recordPath: string) {
  return `review record came from reviewer code ${toolSha} outside the PR base; re-run the review with the base checkout's bin/krn: ${recordPath}`;
}

test('preflight admits review code at the base and its ancestors', async (t) => {
  await t.test('toolSha equals the requested base', async (t) => {
    const { value, reasons } = await recordReasons(t, ({ base }) => base);
    assert.deepEqual(reasons, []);
    assert.equal((await preflight(value)).verdict, 'pass');
  });

  await t.test('toolSha is an ancestor of the requested base', async (t) => {
    const { value, reasons } = await recordReasons(
      t,
      ({ ancestor }) => ancestor,
    );
    assert.deepEqual(reasons, []);
    assert.equal((await preflight(value)).verdict, 'pass');
  });
});

test('preflight refuses schema-valid review records from outside the PR base', async (t) => {
  for (const [label, toolFor] of [
    ['head commit', ({ head }: Awaited<ReturnType<typeof fixture>>) => head],
    ['missing commit', () => 'f'.repeat(40)],
  ] as const) {
    await t.test(label, async (t) => {
      const { value, reasons } = await recordReasons(t, toolFor);
      const path = join(
        value.repo,
        '.krn/runs/review',
        value.head,
        'record.json',
      );
      const reason = reviewerReason(toolFor(value), path);
      assert.deepEqual(reasons, [reason]);
      assert.equal((await preflight(value)).verdict, 'fail');
    });
  }
});

test('preflight retains both schema and reviewer ancestry reasons without duplicates', async (t) => {
  const { value, reasons } = await recordReasons(t, ({ head }) => head, true);
  const path = join(value.repo, '.krn/runs/review', value.head, 'record.json');
  assert.ok(
    reasons.includes(
      `review record does not satisfy the strict schema: ${path}`,
    ),
    reasons.join('\n'),
  );
  assert.equal(
    reasons.filter((reason) => reason.includes('reviewer code')).length,
    1,
  );
  assert.ok(reasons.includes(reviewerReason(value.head, path)));
});
