import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// tsc only checks files its include globs reach; a tracked .ts file outside
// them (evals/ before this test) carries type errors nobody sees.
function uncovered(files: readonly string[], include: readonly string[]) {
  return files.filter(
    (file) => !include.some((glob) => matchesGlob(file, glob)),
  );
}

function tsconfigInclude(): string[] {
  const config: unknown = JSON.parse(
    readFileSync(`${root}tsconfig.json`, 'utf8'),
  );
  if (
    typeof config !== 'object' ||
    config === null ||
    !('include' in config) ||
    !Array.isArray(config.include)
  ) {
    throw new Error('tsconfig.json has no include array');
  }
  return config.include.map(String);
}

test('tsconfig include covers every tracked .ts file', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.ts'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  assert.ok(files.length > 0, 'git ls-files found no .ts files');
  assert.deepEqual(uncovered(files, tsconfigInclude()), []);
});

test('a stray .ts file outside the include globs is reported', () => {
  assert.deepEqual(
    uncovered(
      ['src/a.ts', 'evals/x/run.ts', 'stray/seeded.ts', 'root.ts'],
      tsconfigInclude(),
    ),
    ['stray/seeded.ts', 'root.ts'],
  );
});
