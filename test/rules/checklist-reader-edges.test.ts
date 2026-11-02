import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const api = await import('../../src/brief/index.ts').catch(() => undefined);
const checklist = '- `race`: races are closed.\n';

function setup(t: { after(fn: () => void): void }) {
  assert.equal(typeof api?.checkBrief, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'krn-checklist-edges-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'checklist.md'), checklist);
  const check = (brief: string, list = checklist) => {
    writeFileSync(join(dir, 'brief.md'), brief);
    writeFileSync(join(dir, 'checklist.md'), list);
    return (
      api?.checkBrief(join(dir, 'brief.md'), join(dir, 'checklist.md')) ?? []
    );
  };
  return { dir, check };
}

test('an N/A reason copied from the template is empty', (t) => {
  const f = setup(t);
  for (const reason of ['<reason>', 'TODO', '...', ''])
    assert.deepEqual(f.check(`## Hardening\n- race: N/A: ${reason}\n`), [
      'empty answer for id race at line 2',
    ]);
  assert.deepEqual(f.check('## Hardening\n- race: N/A because\n'), [
    'empty answer for id race at line 2',
  ]);
  assert.deepEqual(f.check('## Hardening\n- race: N/A: read-only\n'), []);
});

test('an ordered checklist item is malformed, not skipped', (t) => {
  const f = setup(t);
  for (const item of ['1. `newid`: text', '2) `newid`: text'])
    assert.deepEqual(
      f.check('## Hardening\n- race: covered\n', `${checklist}${item}\n`),
      ['malformed checklist item at line 2'],
    );
});

test('a dot-dot after a symlink reads the lexically checked file', (t) => {
  const f = setup(t);
  mkdirSync(join(f.dir, 'a'));
  mkdirSync(join(f.dir, 'b', 'sub'), { recursive: true });
  writeFileSync(join(f.dir, 'a', 'brief.md'), '# Brief without hardening\n');
  writeFileSync(
    join(f.dir, 'b', 'brief.md'),
    '## Hardening\n- race: covered\n',
  );
  symlinkSync(join('..', 'b', 'sub'), join(f.dir, 'a', 'link'));
  assert.deepEqual(
    api?.checkBrief(`${f.dir}/a/link/../brief.md`, join(f.dir, 'checklist.md')),
    ['missing Hardening section'],
  );
});

test('a long run of spaces in a heading is checked in linear time', (t) => {
  const f = setup(t);
  const started = performance.now();
  const reasons = f.check(
    `## a${' '.repeat(60_000)}x\n## Hardening ##\n- race: covered\n`,
  );
  assert.deepEqual(reasons, []);
  assert.ok(performance.now() - started < 1000);
});
