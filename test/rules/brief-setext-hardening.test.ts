import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const api = await import('../../src/brief/index.ts').catch(() => undefined);
const checklist = fileURLToPath(
  new URL('../../docs/program/hardening-checklist.md', import.meta.url),
);

function check(t: { after(fn: () => void): void }, brief: string): string[] {
  assert.equal(typeof api?.checkBrief, 'function');
  const root = mkdtempSync(join(tmpdir(), 'krn-brief-setext-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'brief.md');
  writeFileSync(path, brief);
  return api?.checkBrief(path, checklist) ?? [];
}

// Read lazily: at a base without the checklist, checkBrief's typeof
// assertion must fail the test instead of a throw at load.
function readAnswers(): string {
  try {
    return [...readFileSync(checklist, 'utf8').matchAll(/^- `([^`]+)`: /gmu)]
      .map((match) => `- ${match[1]}: covered`)
      .join('\n');
  } catch {
    return '';
  }
}

test('a setext Hardening heading starts the section', (t) => {
  const answers = readAnswers();
  assert.deepEqual(
    check(t, `Brief\n=====\n\nHardening\n---------\n${answers}\n`),
    [],
  );
  assert.deepEqual(
    check(t, `# Brief\n\nHardening\n-\n\n${answers}\n\nNext\n====\n`),
    [],
  );
});

test('setext headings follow the section and duplicate rules', (t) => {
  const answers = readAnswers();
  assert.deepEqual(check(t, `# Brief\n\nHardening\n=========\n${answers}\n`), [
    'missing Hardening section',
  ]);
  assert.deepEqual(
    check(t, `# Brief\n\nSome text\nHardening\n---------\n${answers}\n`),
    ['missing Hardening section'],
  );
  assert.deepEqual(
    check(t, `## Hardening\n${answers}\n\nHardening\n---\n${answers}\n`).slice(
      0,
      1,
    ),
    [`duplicate Hardening section at line ${answers.split('\n').length + 3}`],
  );
});
