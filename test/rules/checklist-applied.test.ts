import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../../src/deliver/transport.ts';

const brief = await import('../../src/brief/index.ts').catch(() => undefined);
const deliver = await import('../../src/deliver/checklist.ts').catch(
  () => undefined,
);
const path = 'docs/program/hardening-checklist.md';

function temp(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'krn-checklist-applied-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function check(
  t: { after(fn: () => void): void },
  checklist: string,
  answers: string,
): string[] {
  assert.equal(typeof brief?.checkBrief, 'function');
  const dir = temp(t);
  writeFileSync(join(dir, 'checklist.md'), checklist);
  writeFileSync(join(dir, 'brief.md'), `# Brief\n\n## Hardening\n${answers}\n`);
  return (
    brief?.checkBrief(join(dir, 'brief.md'), join(dir, 'checklist.md')) ?? []
  );
}

test('an N/A answer needs a reason in every spelling', (t) => {
  const checklist = '- `race`: races are closed.\n';
  for (const answer of [
    'n/a',
    'N/A',
    'NA',
    '**N/A**',
    '`n/a`',
    'N/A:',
    '_NA_:',
  ])
    assert.deepEqual(check(t, checklist, `- race: ${answer}`), [
      'empty answer for id race at line 4',
    ]);
  for (const answer of [
    'N/A: read-only change',
    'n/a: no shared state',
    '**N/A**: nothing persists',
    'na każdej ścieżce O_EXCL',
  ])
    assert.deepEqual(check(t, checklist, `- race: ${answer}`), []);
});

test('a malformed checklist item is refused instead of skipped', (t) => {
  for (const item of ['- newid: text', '* `newid`: text', '- `newid`:'])
    assert.deepEqual(
      check(t, `- \`race\`: races are closed.\n${item}\n`, '- race: covered'),
      ['malformed checklist item at line 2'],
    );
});

test('a second-round record needs a first round that applied the same checklist', (t) => {
  assert.equal(typeof deliver?.requireReviewChecklist, 'function');
  const dir = temp(t);
  const git = (...args: string[]) => {
    const result = run('git', args, dir);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  mkdirSync(join(dir, 'docs/program'), { recursive: true });
  writeFileSync(join(dir, path), '- `race`: races are closed.\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const sha = git('rev-parse', 'HEAD');
  const digest = createHash('sha256')
    .update('- `race`: races are closed.\n')
    .digest('hex');
  const prior = (checklistSha256?: string) => ({
    headSha: 'a'.repeat(40),
    recordSha256: 'b'.repeat(64),
    findings: [],
    changedPaths: [path],
    ...(checklistSha256 === undefined ? {} : { checklistSha256 }),
  });
  const verify = (record: object) =>
    deliver?.requireReviewChecklist(
      { base: sha, headSha: sha, checklist: { sha256: digest }, ...record },
      dir,
      run,
    );
  for (const record of [{ prior: prior() }, { prior: prior('0'.repeat(64)) }])
    assert.throws(() => verify(record), /no judge completed review/u);
  assert.doesNotThrow(() => verify({ prior: prior(digest) }));
});
