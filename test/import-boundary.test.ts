import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { check, LAYERS, specifiers } from '../scripts/boundaries.ts';

const repo = new URL('..', import.meta.url).pathname;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-boundary-'));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

test('core imports only its own files, including nested files and every module form', () => {
  const root = fixture({
    'src/hosts/index.ts': 'export const h = 1;',
    'src/core/nested/static.ts': "import { h } from '../../hosts/index.ts';",
    'src/core/nested/type-only.ts':
      "import type { h } from '../../hosts/index.ts';",
    'src/core/nested/side-effect.ts': "import '../../hosts/index.ts';",
    'src/core/nested/re-export.ts': "export { x } from '../../hosts/index.ts';",
    'src/core/nested/star.ts': "export * from '../../hosts/index.ts';",
    'src/core/nested/dynamic.ts': "await import('../../hosts/index.ts');",
    'src/core/nested/multiline.ts':
      "import {\n  a,\n  b,\n} from '../../hosts/index.ts';",
    'src/core/nested/own.ts':
      "import { x } from './dynamic.ts';\nimport 'node:fs';",
    'src/core/nested/commented.ts':
      "// import '../../hosts/index.ts';\n/* import('../../hosts/x.ts') */",
  });
  try {
    const found = check(root, { core: [], hosts: [] });
    assert.deepEqual(
      found.map((v) => v.file.replace('src/core/nested/', '')).sort(),
      [
        'dynamic.ts',
        'multiline.ts',
        're-export.ts',
        'side-effect.ts',
        'star.ts',
        'static.ts',
        'type-only.ts',
      ],
    );
    assert.equal(found.find((v) => v.file.endsWith('multiline.ts'))?.line, 1);
    assert.equal(found[0]?.edge, 'core -> hosts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file-level exceptions and unmapped areas are enforced', () => {
  const root = fixture({
    'scripts/a.mjs': '',
    'scripts/b.mjs': '',
    'src/flow/x.ts':
      "import '../../scripts/a.mjs';\nimport '../../scripts/b.mjs';",
    'src/new/y.ts': "import '../flow/x.ts';",
  });
  try {
    const found = check(root, { flow: ['scripts/a.mjs'] });
    assert.deepEqual(
      found.map((v) => `${v.file}:${v.line} ${v.edge}`),
      [
        'src/flow/x.ts:2 flow -> scripts',
        'src/new/y.ts:1 new -> flow (area "new" missing from LAYERS)',
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a root without src has no violations instead of failing', () => {
  const root = fixture({ 'a.ts': "import './b.ts';" });
  try {
    assert.deepEqual(check(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('specifiers finds every module form with its line', () => {
  assert.deepEqual(
    specifiers(
      "import a from './a';\nexport * from './b';\nawait import('./c');",
    ),
    [
      { specifier: './a', line: 1 },
      { specifier: './b', line: 2 },
      { specifier: './c', line: 3 },
    ],
  );
});

test('the repository obeys its layer map and core imports nothing', () => {
  assert.deepEqual(LAYERS.core, []);
  assert.deepEqual(check(repo), []);
});
