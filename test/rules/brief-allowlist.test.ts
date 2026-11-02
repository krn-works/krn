import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const api = await import('../../src/brief/index.ts').catch(() => undefined);
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'src/cli/main.ts');

function setup(t: { after(fn: () => void): void }) {
  assert.equal(typeof api?.checkBrief, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'krn-brief-allowlist-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const brief = join(dir, 'brief.md');
  const checklist = join(dir, 'checklist.md');
  writeFileSync(checklist, '- `symlink`: path handling\n');
  const check = (text: string) => {
    writeFileSync(brief, text);
    return api?.checkBrief(brief, checklist) ?? [];
  };
  return { brief, checklist, check, dir };
}

test('Hardening answers must contain three letters or digits after markup removal', (t) => {
  const f = setup(t);
  assert.deepEqual(f.check('## Hardening\n- symlink: <!-- covered -->\n'), [
    'empty answer for id symlink at line 2',
  ]);
  for (const [answer, expected] of [
    ['<b></b>', /empty answer for id symlink at line 2/u],
    ['x', /empty answer for id symlink at line 2/u],
    ['TODO', /empty answer for id symlink at line 2/u],
    ['N/A: x', /empty answer for id symlink at line 2/u],
  ] as const) {
    const reasons = f.check(`## Hardening\n- symlink: ${answer}\n`);
    assert.ok(
      reasons.some((reason) => expected.test(reason)),
      answer,
    );
  }
  assert.deepEqual(
    f.check('## Hardening\n- symlink: N/A: path unchanged\n'),
    [],
  );
});

test('Hardening accepts only answers, continuations, blanks and separated thematic breaks', (t) => {
  const f = setup(t);
  for (const text of [
    '\uFEFF## Hardening\r\n- symlink: covered\r\n',
    'Hardening\n---\n- symlink: covered\n',
    '## Hardening\n- symlink: covered\n  continuation detail\n',
    '## Hardening\n- symlink: covered\n\n---\n',
    '## Hardening\n- symlink: covered\n\n## Proof\nNote: outside section\n',
  ]) {
    assert.deepEqual(f.check(text), [], text);
  }
  for (const line of [
    'Note: x',
    '| class | answer |',
    '> quoted text',
    '---',
  ]) {
    const reasons = f.check(`## Hardening\n- symlink: covered\n${line}\n`);
    assert.ok(
      reasons.includes('unsupported line 3 in Hardening section'),
      line,
    );
  }
});

test('Hardening skips commented and fenced lines, which never answer', (t) => {
  const f = setup(t);
  for (const text of [
    '## Hardening\n<!--\n- symlink: covered\n-->\n',
    '## Hardening\n```md\n- symlink: covered\n```\n',
  ])
    assert.deepEqual(f.check(text), ['missing id symlink'], text);
  for (const text of [
    '## Hardening\n- symlink: covered\n<!-- note\n## Proof\n-->\n### Detail\n',
    '## Hardening\n- symlink: covered\n  ~~~\nprose inside\n  ~~~\n',
  ])
    assert.deepEqual(f.check(text), [], text);
});

test('brief CLI keeps allowlist refusals at exit 65', (t) => {
  const f = setup(t);
  writeFileSync(f.brief, '## Hardening\n- symlink: covered\nNote: x\n');
  const result = spawnSync(
    process.execPath,
    [cli, 'brief', 'check', f.brief, '--checklist', f.checklist],
    { cwd: f.dir, encoding: 'utf8' },
  );
  assert.equal(result.status, 65);
  assert.equal(result.stdout, `FAIL ${f.brief}\n`);
  assert.match(result.stderr, /unsupported line 3 in Hardening section/u);
});

test('brief CLI handles maximum-sized section lines before its one-second deadline', (t) => {
  const f = setup(t);
  const prefix = '## Hardening\n- symlink: covered\n';
  const lineLength = 256 * 1024 - Buffer.byteLength(prefix) - 1;
  for (const [line, status] of [
    [' '.repeat(lineLength), 0],
    ['<'.repeat(lineLength), 65],
  ] as const) {
    writeFileSync(f.brief, `${prefix}${line}\n`);
    const result = spawnSync(
      process.execPath,
      [cli, 'brief', 'check', f.brief, '--checklist', f.checklist],
      { cwd: f.dir, encoding: 'utf8', timeout: 1000 },
    );
    assert.equal(
      result.error,
      undefined,
      'brief check must finish before 1000 ms',
    );
    assert.equal(result.status, status, result.stderr);
  }
});
