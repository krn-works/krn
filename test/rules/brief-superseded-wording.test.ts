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
const id = 'superseded-wording';

test('checklist defines the superseded-wording class for decision amendments', () => {
  const entry = readFileSync(checklist, 'utf8')
    .split('\n')
    .find((line) => line.startsWith(`- \`${id}\`: `));
  assert.ok(entry, 'the checklist must define the superseded-wording class');
  for (const shape of [
    /amend/u,
    /same PR/u,
    /every sentence/u,
    /old gate/u,
    /git grep/u,
    /Deferred/u,
  ])
    assert.match(entry, shape);
});

test('brief check refuses a brief that leaves superseded-wording unanswered', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'krn-brief-superseded-'));
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
  assert.match(missing.stderr, /superseded-wording/u);
  writeFileSync(
    brief,
    `# Brief\n\n## Hardening\n${answers}\n- ${id}: N/A: amends no decision\n`,
  );
  const answered = run();
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(answered.stdout, `PASS ${brief}\n`);
});
