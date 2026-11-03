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
// The classes a brief had to answer before text-scanning guards had a class.
const earlier = [
  'symlink',
  'malformed',
  'crash',
  'race',
  'bounds',
  'exit-codes',
  'text-grammar',
  'secrets',
  'trust',
];

test('checklist bounds text-scanning guards by contract shape', () => {
  const line = readFileSync(checklist, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('- `text-scanner`: '));
  assert.ok(line, 'the checklist must define the text-scanner class');
  assert.match(line, /concrete shapes/u);
  assert.match(line, /non-goal/u);
  assert.match(line, /fails closed/u);
});

// Classes added after text-scanner; the answered brief must cover them too.
const later = [...readFileSync(checklist, 'utf8').matchAll(/^- `([^`]+)`: /gmu)]
  .map((match) => match[1] as string)
  .filter((id) => id !== 'text-scanner' && !earlier.includes(id))
  .map((id) => `- ${id}: N/A: not touched\n`)
  .join('');

test('brief check refuses a brief that leaves the text-scanner class unanswered', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'krn-brief-text-scanner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const brief = join(root, 'brief.md');
  const answers = earlier.map((id) => `- ${id}: covered`).join('\n');
  writeFileSync(brief, `# Brief\n\n## Hardening\n${answers}\n`);
  const run = () =>
    spawnSync(
      process.execPath,
      [cli, 'brief', 'check', brief, '--checklist', checklist],
      { cwd: root, encoding: 'utf8' },
    );
  const missing = run();
  assert.equal(missing.status, 65);
  assert.equal(missing.stdout, `FAIL ${brief}\n`);
  assert.match(missing.stderr, /text-scanner/u);
  writeFileSync(
    brief,
    `# Brief\n\n## Hardening\n${answers}\n- text-scanner: N/A: no source-text guard\n${later}`,
  );
  const answered = run();
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(answered.stdout, `PASS ${brief}\n`);
});
