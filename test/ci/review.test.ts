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
import { run } from '../../src/ci/command.ts';
import {
  type ReviewInput,
  reviewEnvironment,
  reviewTier,
  startReview,
} from '../../src/ci/review.ts';
import { validateFindings } from '../../src/cli/findings.ts';

const never = () => false;

test('the tier of a diff follows its paths and its size outside tests, docs and records', () => {
  const rows = (...r: string[]) => r.join('\n');
  assert.equal(reviewTier(rows('3\t1\ttasks/t-aaaaaaa.json'), never), 0);
  assert.equal(
    reviewTier(rows('900\t0\ttest/x.test.ts', '40\t2\tdocs/a.md'), never),
    0,
  );
  assert.equal(reviewTier(rows('20\t5\tsrc/task/store.ts'), never), 1);
  assert.equal(reviewTier(rows('1\t0\tsrc/ci/ship.ts'), never), 2);
  assert.equal(reviewTier(rows('1\t0\t.github/workflows/ci.yml'), never), 2);
  assert.equal(reviewTier(rows('1\t0\tsrc/cli/lane-run/steps.ts'), never), 2);
  assert.equal(reviewTier(rows('100\t51\tsrc/task/store.ts'), never), 2);
  assert.equal(reviewTier(rows('100\t50\tsrc/task/store.ts'), never), 1);
  assert.equal(
    reviewTier(
      rows('1\t0\tscripts/test-suite.mjs'),
      (p) => p === 'scripts/test-suite.mjs',
    ),
    2,
  );
  // A rename is judged by its new path.
  assert.equal(reviewTier(rows('0\t0\tsrc/{task => hook}/a.ts'), never), 2);
  assert.equal(reviewTier(rows('-\t-\tsrc/task/logo.png'), never), 1);
});

test('the reviewer and its reproductions get no credential of the shell', () => {
  const env = reviewEnvironment({
    PATH: '/bin',
    GH_TOKEN: 'x',
    GITHUB_TOKEN: 'x',
    ANTHROPIC_API_KEY: 'x',
    BW_SESSION: 'x',
    HOME: '/h',
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

/** A repository whose origin/main is the base and whose HEAD adds `file` with `text`. */
function fixture(
  t: { after(fn: () => void): void },
  file: string,
  text: string,
) {
  const root = mkdtempSync(join(tmpdir(), 'krn-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.krn/\n');
  mkdirSync(join(root, 'src', 'ci'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'ci', 'gate.ts'),
    'export const ok = true;\n',
  );
  git('add', '.');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  mkdirSync(join(root, file, '..'), { recursive: true });
  writeFileSync(join(root, file), text);
  git('add', '.');
  git('commit', '-qm', 'change');
  return { root, head: git('rev-parse', 'HEAD') };
}

/** A reviewer that records its run and writes `findings` to KRN_REVIEW_OUT. */
function reviewer(root: string, findings: unknown[], exit = 0): string {
  const answer = join(root, '.krn', 'answer.json');
  mkdirSync(join(root, '.krn'), { recursive: true });
  writeFileSync(answer, JSON.stringify({ findings }));
  return `echo ran >> "${join(root, '.krn', 'ran')}"; cp "${answer}" "$KRN_REVIEW_OUT"; exit ${exit}`;
}

function input(
  f: { root: string; head: string },
  command: string | undefined,
  comments: string[],
  extra: Partial<ReviewInput> = {},
): ReviewInput {
  return {
    main: f.root,
    cwd: f.root,
    base: 'origin/main',
    head: f.head,
    command,
    inFrame: never,
    comment: async (body) => {
      comments.push(body);
    },
    run,
    now: Date.now,
    timeoutMs: 60_000,
    ...extra,
  };
}

const ran = (root: string) =>
  existsSync(join(root, '.krn', 'ran'))
    ? readFileSync(join(root, '.krn', 'ran'), 'utf8')
        .trim()
        .split('\n').length
    : 0;

test('a tier 2 finding that fails on the head and passes on the base blocks, with a valid record and one comment', async (t) => {
  const f = fixture(t, 'src/ci/gate.ts', 'export const ok = false; // BUG\n');
  const comments: string[] = [];
  const review = startReview(
    input(
      f,
      reviewer(f.root, [
        {
          id: 'gate-open',
          title: 'the gate passes a red check',
          evidence: ['src/ci/gate.ts:1'],
          reproduce: '! grep -q BUG src/ci/gate.ts',
          class: 'gate-self',
        },
        {
          id: 'guess',
          title: 'a hunch with no failing command',
          evidence: ['src/ci/gate.ts:1'],
          reproduce: 'true',
        },
      ]),
      comments,
    ),
  );
  assert.match(review.line, /tier 2/u);
  const verdict = await review.verdict(f.head);
  assert.equal(verdict.kind, 'block');
  assert.equal(comments.length, 1);
  assert.match(
    comments[0] ?? '',
    /^krn-review: [0-9a-f]{40} [0-9a-f]{40} tier 2 block/u,
  );
  assert.match(comments[0] ?? '', /\*\*reproduced\*\* the gate passes/u);
  assert.match(comments[0] ?? '', /\*\*not reproduced\*\* a hunch/u);
  const records = join(f.root, '.krn', 'runs', 'review');
  const record = JSON.parse(
    readFileSync(
      join(records, `${(comments[0] ?? '').split(' ')[2]}.json`),
      'utf8',
    ),
  );
  assert.deepEqual(validateFindings(record), []);
  // The scratch worktree is gone and the same head asked again is not posted twice.
  assert.equal(
    spawnSync('git', ['-C', f.root, 'worktree', 'list'])
      .stdout.toString()
      .trim()
      .split('\n').length,
    1,
  );
  await review.verdict(f.head);
  assert.equal(comments.length, 1);
});

test('a reproduce command that is red on the base too stays unreproduced and the ship passes', async (t) => {
  const f = fixture(t, 'src/ci/gate.ts', 'export const ok = false;\n');
  const comments: string[] = [];
  const review = startReview(
    input(
      f,
      reviewer(f.root, [
        {
          id: 'red',
          title: 'red everywhere',
          evidence: ['src/ci/gate.ts:1'],
          reproduce: 'exit 1',
        },
        {
          id: 'missing',
          title: 'no such command',
          evidence: ['src/ci/gate.ts:1'],
          reproduce: 'no-such-binary-x',
        },
      ]),
      comments,
    ),
  );
  const verdict = await review.verdict(f.head);
  assert.equal(verdict.kind, 'pass');
  assert.match(comments[0] ?? '', /tier 2 pass/u);
});

test('below tier 2 the reviewer never runs', async (t) => {
  const f = fixture(t, 'src/task/a.ts', 'export const a = 1;\n');
  const comments: string[] = [];
  const review = startReview(input(f, reviewer(f.root, []), comments));
  assert.equal(review.line, 'review: tier 1, not reviewed');
  assert.equal((await review.verdict(f.head)).kind, 'skip');
  assert.equal(ran(f.root), 0);
  assert.equal(comments.length, 0);
});

test('a tier 2 diff in a repository with no review command is skipped with a line', async (t) => {
  const f = fixture(t, 'src/ci/gate.ts', 'export const ok = 1;\n');
  const review = startReview(input(f, undefined, []));
  assert.match(review.line, /krn.json names no review command/u);
  assert.equal((await review.verdict(f.head)).kind, 'skip');
});

test('a reviewer that fails or outlives its time is silent, never a pass', async (t) => {
  const f = fixture(t, 'src/ci/gate.ts', 'export const ok = 1;\n');
  const failed = startReview(input(f, reviewer(f.root, [], 3), []));
  const first = await failed.verdict(f.head);
  assert.equal(first.kind, 'silent');
  assert.match(first.line, /exited 3/u);
  const slow = startReview(input(f, 'sleep 30', [], { timeoutMs: 100 }));
  const second = await slow.verdict(f.head);
  assert.equal(second.kind, 'silent');
  assert.match(second.line, /stopped/u);
});

test('a patch that passed keeps its verdict on a rerun: no second review, no second comment', async (t) => {
  const f = fixture(t, 'src/ci/gate.ts', 'export const ok = 2;\n');
  const command = reviewer(f.root, []);
  const comments: string[] = [];
  assert.equal(
    (await startReview(input(f, command, comments)).verdict(f.head)).kind,
    'pass',
  );
  assert.equal(
    (await startReview(input(f, command, comments)).verdict(f.head)).kind,
    'pass',
  );
  assert.equal(ran(f.root), 1);
  assert.equal(comments.length, 1);
});

test('dispose stops a running reviewer and removes its scratch worktree', async (t) => {
  const f = fixture(t, 'src/ci/gate.ts', 'export const ok = 3;\n');
  const review = startReview(input(f, 'sleep 30', []));
  const pending = review.verdict(f.head);
  review.dispose();
  assert.equal((await pending).kind, 'silent');
  const listed = spawnSync('git', [
    '-C',
    f.root,
    'worktree',
    'list',
  ]).stdout.toString();
  assert.equal(listed.trim().split('\n').length, 1);
});

test('a verbatim Codex answer parses through the answer schema and reaches the record and the comment', async (t) => {
  const f = fixture(t, 'src/ci/gate.ts', 'export const ok = false;\n');
  const answer = join(
    import.meta.dirname,
    '..',
    'fixtures',
    'codex',
    'review-findings.json',
  );
  const comments: string[] = [];
  const review = startReview(
    input(f, `cp "${answer}" "$KRN_REVIEW_OUT"`, comments),
  );
  const verdict = await review.verdict(f.head);
  // Its reproduction imports modules this fixture repository lacks: never reproduced, never a block.
  assert.equal(verdict.kind, 'pass');
  assert.equal(verdict.kind === 'pass' ? verdict.findings.length : 0, 1);
  assert.match(comments[0] ?? '', /\*\*not reproduced\*\* Zielony `Check`/u);
});

test('a one-line change to a non-ASCII path under a risky prefix is tier 2, not hidden by git quoting', async (t) => {
  const f = fixture(t, 'src/ci/żółć.ts', 'export const a = 1;\n');
  const review = startReview(input(f, undefined, []));
  assert.match(review.line, /tier 2/u);
});

test('a tracked file a head reproduction edits is restored before the base run, so the defect still blocks', async (t) => {
  const f = fixture(t, 'src/ci/gate.ts', 'export const ok = false; // BUG\n');
  const comments: string[] = [];
  const review = startReview(
    input(
      f,
      reviewer(f.root, [
        {
          id: 'dirty',
          title: 'the reproduction leaves an edit behind',
          evidence: ['src/ci/gate.ts:1'],
          reproduce:
            'if grep -q BUG src/ci/gate.ts; then echo dirty > .gitignore; exit 1; fi; ! grep -q dirty .gitignore',
        },
      ]),
      comments,
    ),
  );
  const verdict = await review.verdict(f.head);
  assert.equal(verdict.kind, 'block');
});
