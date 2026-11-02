import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../../src/deliver/transport.ts';

const binding = await import('../../src/deliver/checklist.ts').catch(
  () => undefined,
);
const path = 'docs/program/hardening-checklist.md';
const before = '- `race`: races are closed.\n';
const after = `${before}- \`signal\`: signals are handled.\n`;
const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

const prior = (checklistSha256?: string) => ({
  headSha: 'a'.repeat(40),
  recordSha256: 'b'.repeat(64),
  findings: [],
  changedPaths: [path],
  ...(checklistSha256 === undefined ? {} : { checklistSha256 }),
});

// Round one reviewed `before`; the PR then edited the checklist to `after`.
function edited(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'krn-checklist-round-two-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = run('git', args, dir);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  mkdirSync(join(dir, 'docs/program'), { recursive: true });
  writeFileSync(join(dir, path), before);
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, path), after);
  git('commit', '-qam', 'edit checklist between rounds');
  const headSha = git('rev-parse', 'HEAD');
  return (record: {
    checklist?: { sha256: string };
    prior?: ReturnType<typeof prior>;
  }) => binding?.requireReviewChecklist({ base, headSha, ...record }, dir, run);
}

test('round two delivers after the checklist was edited between rounds', (t) => {
  assert.equal(typeof binding?.requireReviewChecklist, 'function');
  const verify = edited(t);
  assert.doesNotThrow(() =>
    verify({
      checklist: { sha256: sha256(after) },
      prior: prior(sha256(before)),
    }),
  );
});

test('round two still binds the current round to the head checklist', (t) => {
  assert.equal(typeof binding?.requireReviewChecklist, 'function');
  const verify = edited(t);
  assert.throws(
    () =>
      verify({
        checklist: { sha256: sha256(before) },
        prior: prior(sha256(before)),
      }),
    /differs from the head blob/u,
  );
  assert.throws(
    () => verify({ prior: prior(sha256(before)) }),
    /missing or differs from the head blob/u,
  );
  assert.throws(
    () => verify({ checklist: { sha256: sha256(after) }, prior: prior() }),
    /no judge completed review/u,
  );
});
