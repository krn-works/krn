import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);
const docs = tracked.filter((file) => file.startsWith('docs/'));
// Records and captures quote paths without reading them.
const readers = tracked.filter(
  (file) =>
    !file.startsWith('docs/') &&
    !file.startsWith('tasks/') &&
    !file.startsWith('test/fixtures/') &&
    !/^evals\/[^/]+\/results/u.test(file) &&
    /\.(md|ts|mjs|json|sh|yml|yaml)$/u.test(file),
);
const text = new Map(
  [...docs, ...readers].map((file) => [
    file,
    readFileSync(`${root}${file}`, 'utf8'),
  ]),
);

// A document is read when a rule, test, skill, hook or script names its path,
// or a document that is itself read links it by file name.
function reachableDocs(
  files: string[],
  readerFiles: string[],
  body: (file: string) => string,
): Set<string> {
  const reached = new Set(
    files.filter((doc) => readerFiles.some((file) => body(file).includes(doc))),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const doc of files) {
      if (reached.has(doc)) continue;
      const name = basename(doc);
      if ([...reached].some((other) => body(other).includes(name))) {
        reached.add(doc);
        grew = true;
      }
    }
  }
  return reached;
}

test('every file under docs/ is named by something that reads it', () => {
  const reached = reachableDocs(docs, readers, (f) => text.get(f) ?? '');
  const orphans = docs.filter((doc) => !reached.has(doc));
  assert.deepEqual(
    orphans,
    [],
    `unreferenced documents: ${orphans.join(', ')}`,
  );
});

test('a document nothing names is reported, and a linked one is read', () => {
  const bodies: Record<string, string> = {
    'src/a.ts': 'see docs/x/one.md',
    'docs/x/one.md': '[two](two.md)',
    'docs/x/two.md': 'text',
    'docs/x/orphan.md': 'text',
  };
  const reached = reachableDocs(
    ['docs/x/one.md', 'docs/x/two.md', 'docs/x/orphan.md'],
    ['src/a.ts'],
    (f) => bodies[f] ?? '',
  );
  assert.deepEqual([...reached].sort(), ['docs/x/one.md', 'docs/x/two.md']);
});
