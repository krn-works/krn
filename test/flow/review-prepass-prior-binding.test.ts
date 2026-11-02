import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadPriorReview, PriorRecordError } from '../../src/flow/prior.ts';
import {
  attemptRecordPath,
  reserveReviewAttempt,
} from '../../src/flow/series.ts';
import { panelRoles, reviewRecordSchema } from '../../src/flow/types.ts';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-prepass-binding-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Review test');
  git(repo, 'config', 'user.email', 'review@example.invalid');
  writeFileSync(join(repo, 'src.ts'), 'export const answer = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial behavior');
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src.ts'), 'export const answer = 2;\n');
  git(repo, 'commit', '-qam', 'first reviewed behavior');
  const priorHead = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src.ts'), 'export const answer = 0;\n');
  git(repo, 'commit', '-qam', 'fixed behavior');
  const currentHead = git(repo, 'rev-parse', 'HEAD');
  const identity = {
    schemaVersion: 1 as const,
    repository: 'example/repo',
    pr: 18,
    baseRef: 'main',
  };
  const attempt = reserveReviewAttempt(repo, identity, base, priorHead);
  const record = reviewRecordSchema.parse({
    schemaVersion: 1,
    attempt,
    headSha: priorHead,
    base,
    createdAt: '2026-01-01T00:00:00.000Z',
    redFirst: [],
    judges: [],
    prepass: {
      state: 'complete',
      findings: [
        {
          severity: 'BLOCKING',
          title: 'Empty input fails',
          path: 'src.ts',
          line: 1,
          defect: 'An empty input throws instead of returning zero.',
          fix: 'Return zero for an empty input.',
        },
      ],
      sessionId: 'prepass-session',
    },
  });
  const path = attemptRecordPath(repo, attempt);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return { root, repo, currentHead, path, identity };
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PriorRecordError, String(error));
    return error.message;
  }
  return 'accepted';
}

test('a prepass-only prior without a PR review series is refused as unbound', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  assert.match(
    refusal(() =>
      loadPriorReview(f.repo, f.currentHead, f.path, { panel: panelRoles }),
    ),
    /prepass-only record requires a PR review series/u,
  );
  assert.match(
    refusal(() => loadPriorReview(f.repo, f.currentHead, f.path)),
    /prepass-only record requires a PR review series/u,
  );
});

test('the same prepass-only prior bound to its PR series is accepted', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  assert.equal(
    refusal(() =>
      loadPriorReview(f.repo, f.currentHead, f.path, {
        panel: panelRoles,
        identity: f.identity,
      }),
    ),
    'accepted',
  );
});
