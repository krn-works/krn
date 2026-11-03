import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { newReviewRecordSchema } from '../src/flow/types.ts';
import { serializeTask } from '../src/task/record.ts';
import {
  gateCheck,
  reviewEvidence,
  writeReviewEvidence,
} from './helpers/ship-evidence.ts';

const scriptUrl = new URL('../scripts/pr-preflight.mjs', import.meta.url);
const { runPreflight } = await import(scriptUrl.href);
const reportSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  reasons: z.array(z.string()),
  reviewRecords: z.array(
    z.object({
      verdict: z.string().optional(),
      panelVerdict: z.string().optional(),
    }),
  ),
});

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'krn-ship-prepass-override-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repository');
  await mkdir(repo);
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
  ])
    delete env[key];
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Ship prepass override fixture']);
  git(['config', 'user.email', 'ship@example.test']);
  git(['remote', 'add', 'origin', 'https://github.com/krn-works/krn.git']);
  await mkdir(join(repo, 'src'));
  await mkdir(join(repo, 'test'));
  await mkdir(join(repo, 'tasks'));
  await writeFile(join(repo, '.gitignore'), '.krn/\n');
  await writeFile(join(repo, 'src', 'index.ts'), 'export const value = 1;\n');
  await writeFile(join(repo, 'test', 'example.test.ts'), 'export {};\n');
  await writeFile(
    join(repo, 'tasks', 'LON-230.json'),
    serializeTask({
      id: 'LON-230',
      status: 'open',
      resolution: null,
      created: '2026-10-26',
      priority: 1,
      title: 'Ship fixture',
      after: [],
      body: [],
    }),
  );
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'fixture root']);
  const base = git(['rev-parse', 'HEAD']);
  git([
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'fixture head',
    '-m',
    'Ticket: LON-230',
  ]);
  const head = git(['rev-parse', 'HEAD']);
  const input = { repo, base, head, pr: 27 };
  const pull = {
    number: 27,
    title: 'feat(ship): verify fixture (LON-230)',
    base: { sha: base, ref: 'main', repo: { full_name: 'krn-works/krn' } },
    head: { sha: head },
  };
  const record = reviewEvidence(base, head);
  const recordPath = await writeReviewEvidence(repo, base, head, record);
  const verify = async () =>
    reportSchema.parse(
      await runPreflight(input, {
        readPull: async () => ({ ok: true, value: pull }),
        readStatuses: async () => ({ ok: true, value: [] }),
        readCheckRuns: async (...args: unknown[]) => {
          assert.deepEqual(args, [repo, 'krn-works/krn', head]);
          return {
            ok: true,
            value: [gateCheck()].map((check) => ({ head_sha: head, ...check })),
          };
        },
      }),
    );
  const save = (value: unknown) =>
    writeFile(recordPath, `${JSON.stringify(value)}\n`);
  return { repo, base, head, record, verify, save };
}

function prepassOnly(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    ...value.record,
    panelVerdict: undefined,
    panel: undefined,
    judges: [],
    prepass: {
      state: 'complete' as const,
      findings: [
        {
          severity: 'BLOCKING' as const,
          title: 'Empty input fails',
          path: 'src/index.ts',
          line: 1,
          defect: 'An empty input throws instead of returning zero.',
          fix: 'Return zero for an empty input.',
        },
      ],
      sessionId: 'prepass-session',
    },
  };
}

const override = {
  reason: 'Lead accepts the recorded defect',
  evidence: 'Observed receiver proof',
  appendedAt: '2026-10-26T11:00:00Z',
};

test('ship verifier accepts an overridden complete blocking prepass', async (t) => {
  const value = await fixture(t);
  const record = newReviewRecordSchema.parse({
    ...prepassOnly(value),
    override,
  });
  await value.save(record);

  const report = await value.verify();
  assert.equal(report.verdict, 'pass', JSON.stringify(report.reasons));
  assert.equal(report.reviewRecords[0]?.panelVerdict, undefined);
  assert.equal(report.reviewRecords[0]?.verdict, 'overridden');
});

test('ship verifier refuses a blocking prepass without override', async (t) => {
  const value = await fixture(t);
  await value.save(newReviewRecordSchema.parse(prepassOnly(value)));

  const report = await value.verify();
  assert.equal(report.verdict, 'fail');
  assert.match(
    report.reasons.join('\n'),
    /review panel is INCOMPLETE without override/u,
  );
});

test('ship verifier refuses an override on an incomplete prepass record', async (t) => {
  const value = await fixture(t);
  const record = {
    ...prepassOnly(value),
    prepass: { ...prepassOnly(value).prepass, state: 'incomplete' as const },
    override,
  };
  assert.equal(newReviewRecordSchema.safeParse(record).success, false);
  await value.save(record);

  const report = await value.verify();
  assert.equal(report.verdict, 'fail');
  assert.match(
    report.reasons.join('\n'),
    /review record does not satisfy the strict schema/u,
  );
});
