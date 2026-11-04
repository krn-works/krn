import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../src/cli/krn.mjs', import.meta.url));
const checklist = fileURLToPath(
  new URL('../../docs/program/hardening-checklist.md', import.meta.url),
);
const id = 'one-line-text';

test('checklist defines the one-line-text class for printed external text', () => {
  const entry = readFileSync(checklist, 'utf8')
    .split('\n')
    .find((line) => line.startsWith(`- \`${id}\`: `));
  assert.ok(entry, 'the checklist must define the one-line-text class');
  for (const shape of [/LF/u, /CR/u, /U\+2028/u, /U\+2029/u, /Cc/u, /Cf/u])
    assert.match(entry, shape);
  assert.match(entry, /fixture/u);
  assert.match(entry, /check output/u);
});

test('brief check refuses a brief that leaves one-line-text unanswered', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'krn-brief-one-line-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const brief = join(root, 'brief.md');
  const others = [
    ...readFileSync(checklist, 'utf8').matchAll(/^- `([^`]+)`: /gmu),
  ]
    .map((match) => match[1] as string)
    .filter((other) => other !== id);
  const answers = others.map((other) => `- ${other}: covered`).join('\n');
  const run = () =>
    spawnSync(
      process.execPath,
      [cli, 'brief', 'check', brief, '--checklist', checklist],
      { cwd: root, encoding: 'utf8' },
    );
  writeFileSync(brief, `# Brief\n\n## Hardening\n${answers}\n`);
  const missing = run();
  assert.equal(missing.status, 65, missing.stdout);
  assert.equal(missing.stdout, `FAIL ${brief}\n`);
  assert.match(missing.stderr, /one-line-text/u);
  writeFileSync(
    brief,
    `# Brief\n\n## Hardening\n${answers}\n- ${id}: N/A: prints no external text\n`,
  );
  const answered = run();
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(answered.stdout, `PASS ${brief}\n`);
});
