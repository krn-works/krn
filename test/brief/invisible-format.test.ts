import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const cli = resolve('src/cli/main.ts');
const brief = (settled: string) =>
  `## Settled decisions\n- keep it\n- ${settled}\n## Hardening\n- symlink: covered\n`;

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'krn-invisible-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'checklist'), '- `symlink`: paths\n');
  return (text: string) => {
    writeFileSync(join(dir, 'brief'), text);
    return spawnSync(
      process.execPath,
      [cli, 'brief', 'check', 'brief', '--checklist', 'checklist'],
      { cwd: dir, encoding: 'utf8' },
    );
  };
}

test('brief check refuses a raw invisible format character and names its line', (t) => {
  const check = setup(t);
  const accepted = check(brief('strip `\\uFEFF` or `\\u{200B}` escapes'));
  assert.equal(accepted.status, 0, accepted.stderr);
  const bom = check(`\uFEFF${brief('a leading BOM is the file encoding')}`);
  assert.equal(bom.status, 0, bom.stderr);
  const raw = [
    0xfeff, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a,
    0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ];
  for (const code of raw) {
    const hex = code.toString(16).toUpperCase();
    const r = check(brief(`strip \`${String.fromCodePoint(code)}\` escapes`));
    assert.equal(r.status, 65, `U+${hex}: ${r.stderr}`);
    assert.match(
      r.stderr,
      new RegExp(`line 3: raw invisible character U\\+${hex}`, 'u'),
      `U+${hex}`,
    );
  }
});
