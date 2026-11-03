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
const lifecycle = ['identity', 'stale-state'];

const line = (id: string) =>
  readFileSync(checklist, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith(`- \`${id}\`: `));

test('checklist defines the identity class for process-lifecycle code', () => {
  const entry = line('identity');
  assert.ok(entry, 'the checklist must define the identity class');
  assert.match(entry, /start time/u);
  assert.match(entry, /command line/u);
  assert.match(entry, /unit/u);
  assert.match(entry, /never trusted/u);
});

test('checklist defines the stale-state class for earlier-session artefacts', () => {
  const entry = line('stale-state');
  assert.ok(entry, 'the checklist must define the stale-state class');
  assert.match(entry, /session id/u);
  assert.match(entry, /refused/u);
  assert.match(entry, /spawns nothing/u);
});

test('brief check refuses a brief that leaves a process-lifecycle class unanswered', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'krn-brief-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const brief = join(root, 'brief.md');
  const others = [
    ...readFileSync(checklist, 'utf8').matchAll(/^- `([^`]+)`: /gmu),
  ]
    .map((match) => match[1] as string)
    .filter((id) => !lifecycle.includes(id));
  const answers = others.map((id) => `- ${id}: covered`).join('\n');
  const run = () =>
    spawnSync(
      process.execPath,
      [cli, 'brief', 'check', brief, '--checklist', checklist],
      { cwd: root, encoding: 'utf8' },
    );
  for (const id of lifecycle) {
    const rest = lifecycle
      .filter((other) => other !== id)
      .map((other) => `- ${other}: N/A: no process lifecycle`)
      .join('\n');
    writeFileSync(brief, `# Brief\n\n## Hardening\n${answers}\n${rest}\n`);
    const missing = run();
    assert.equal(missing.status, 65, `${id}: ${missing.stdout}`);
    assert.equal(missing.stdout, `FAIL ${brief}\n`);
    assert.match(missing.stderr, new RegExp(id, 'u'));
  }
  const all = lifecycle
    .map((id) => `- ${id}: N/A: no process lifecycle`)
    .join('\n');
  writeFileSync(brief, `# Brief\n\n## Hardening\n${answers}\n${all}\n`);
  const answered = run();
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(answered.stdout, `PASS ${brief}\n`);
});
