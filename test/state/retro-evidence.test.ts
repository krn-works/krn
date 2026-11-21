// Regression cases reproduced by the PR review of the retro evidence reader: each names an edge a hand-written predicate missed (review row shapes, project directory encoding, null records, directories, quoted paths).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { reviewComment } from '../../src/ci/review.ts';
import { projectSlug } from '../../src/harness/transcript-prefix.ts';
import { recentTranscriptFiles } from '../../src/harness/transcripts.ts';
import { git } from '../../src/state/git.ts';
import { checkouts } from '../../src/state/retro-causes.ts';
import {
  normalizeLine,
  parseReviewComment,
  readTranscript,
} from '../../src/state/retro-evidence.ts';

function scratch(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'retro-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function transcript(projects: string, cwd: string) {
  const dir = join(projects, projectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'session.jsonl');
  writeFileSync(
    path,
    JSON.stringify({ cwd, type: 'user', message: { content: 'Hello' } }),
  );
  return path;
}

test('nonblocking-review-row', () => {
  const body = reviewComment('head', 'patch', {
    kind: 'pass',
    line: 'review: pass',
    findings: [
      {
        id: 'example',
        title: 'A harmless input is refused.',
        evidence: ['src/guard.ts:12'],
        kind: 'over-refusal',
        status: 'confirmed',
        foundBy: 'reviewer',
      },
    ],
  });
  assert.deepEqual(
    parseReviewComment(body, 42, 1).map((item) => item.pointer),
    ['PR#42:src/guard.ts:12'],
  );
});

test('null-transcript-entry', () => {
  const lines = [
    'null',
    '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"disk error"}]}}',
  ];
  assert.deepEqual(
    readTranscript(lines, 's').map((item) => item.text),
    ['disk error'],
  );
});

test('encoded-project-directory', (t) => {
  const projects = scratch(t);
  const cwd = '/workspace/my_repo';
  const expected = transcript(projects, cwd);
  assert.deepEqual(recentTranscriptFiles([cwd], 1, projects), [expected]);
});

test('unrelated-project-with-shared-prefix', (t) => {
  const projects = scratch(t);
  transcript(projects, '/workspace/app2');
  assert.deepEqual(recentTranscriptFiles(['/workspace/app'], 1, projects), []);
});

test('external-linked-worktree', (t) => {
  const temp = scratch(t);
  const main = join(temp, 'main');
  const linked = join(temp, 'linked');
  const projects = join(temp, 'projects');
  mkdirSync(main);
  assert.equal(git(main, ['init', '-q']).ok, true);
  assert.equal(
    git(main, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'initial',
      '--allow-empty',
    ]).ok,
    true,
  );
  assert.equal(
    git(main, ['worktree', 'add', '-q', '--detach', linked]).ok,
    true,
  );
  transcript(projects, linked);
  assert.equal(recentTranscriptFiles(checkouts(linked), 1, projects).length, 1);
});

test('directory-with-jsonl-suffix', (t) => {
  const projects = scratch(t);
  const cwd = '/workspace/app';
  const expected = transcript(projects, cwd);
  mkdirSync(join(projects, projectSlug(cwd), 'backup.jsonl'));
  assert.deepEqual(recentTranscriptFiles([cwd], 2, projects), [expected]);
});

test('same-error-with-different-quoted-paths', () => {
  assert.equal(
    normalizeLine(
      "ENOENT: no such file or directory, open '/workspace/main/report.json'",
    ),
    normalizeLine(
      "ENOENT: no such file or directory, open '/workspace/linked/report.json'",
    ),
  );
});

test('review-path-containing-parentheses', () => {
  const body = reviewComment('head', 'patch', {
    kind: 'block',
    line: 'review: block',
    findings: [
      {
        id: 'example',
        title: 'The route returns the wrong page.',
        evidence: ['src/app/(group)/page.tsx:12'],
        kind: 'other',
        status: 'confirmed',
        foundBy: 'reviewer',
      },
    ],
  });
  assert.deepEqual(
    parseReviewComment(body, 42, 1).map((item) => item.pointer),
    ['PR#42:src/app/(group)/page.tsx:12'],
  );
});
