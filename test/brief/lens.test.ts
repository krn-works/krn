import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const cli = resolve('src/cli/main.ts');
const settledHeader =
  'Settled decisions (verbatim from the brief; do not re-decide or flag them):\n';
const residualHeader =
  'Hardening residuals (accepted in the brief; do not flag them as BLOCKING):\n';

function lens(t: { after(fn: () => void): void }, text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'krn-lens-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'brief'), text);
  return spawnSync(process.execPath, [cli, 'brief', 'lens', 'brief'], {
    cwd: dir,
    encoding: 'utf8',
  });
}

test('lens appends accepted Hardening residuals after Settled decisions', (t) => {
  const r = lens(
    t,
    [
      '## Hardening',
      '- symlink: N/A: no new path',
      '- `race`: the task guard check-then-act gap is accepted;',
      '  a concurrent create wins and the next run refuses.',
      '- malformed: n/a: unchanged parser',
      '- crash: NA: nothing persisted',
      '',
      '```',
      '- bounds: fenced, never a residual',
      '```',
      '- stale-state: a leftover claim is accepted as a residual.',
      '## Settled decisions',
      '1. Keep the exit code.',
      '## Steps',
      '1. Write test/brief/lens.test.ts and run it red.',
      '',
    ].join('\n'),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    settledHeader +
      '1. Keep the exit code.\n' +
      '\n' +
      residualHeader +
      '- `race`: the task guard check-then-act gap is accepted;\n' +
      '  a concurrent create wins and the next run refuses.\n' +
      '- stale-state: a leftover claim is accepted as a residual.\n',
  );
});

test('lens without residuals prints only Settled decisions', (t) => {
  const r = lens(
    t,
    '## Settled decisions\n1. Keep.\n## Hardening\n- symlink: N/A: none\n',
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${settledHeader}1. Keep.\n`);
  const missing = lens(t, '## Hardening\n- race: accepted\n');
  assert.equal(missing.status, 65);
  assert.equal(missing.stdout, '');
});

test('a duplicate Hardening section stays a check reason, not a lens error', (t) => {
  const r = lens(
    t,
    '## Settled decisions\n1. Keep.\n## Hardening\n- race: first\n## Hardening\n- race: second\n',
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    `${settledHeader}1. Keep.\n\n${residualHeader}- race: first\n`,
  );
});

test('CRLF residual lines stay verbatim', (t) => {
  const r = lens(
    t,
    '## Settled decisions\r\n1. Keep.\r\n## Hardening\r\n- race: accepted\r\n  continued\r\n- crash: N/A: none\r\n',
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    `${settledHeader}1. Keep.\r\n\n${residualHeader}- race: accepted\r\n  continued\r\n`,
  );
});
