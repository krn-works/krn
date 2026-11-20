import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  BINARIES,
  check,
  checkBinaries,
  checkStores,
  checkWriters,
  LAYERS,
  PRODUCT_WORKSHOP_EXCEPTIONS,
  specifiers,
} from '../scripts/boundaries.ts';

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
        'src/flow/x.ts:2 flow -> root:scripts',
        'src/new/y.ts:1 new -> flow (area "new" missing from LAYERS)',
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a src area name never allows the top-level directory of the same name', () => {
  const root = fixture({
    'evals/fr40/tasks.ts': '',
    'src/evals/run.ts': '',
    'src/brain/x.ts':
      "import '../evals/run.ts';\nimport '../../evals/fr40/tasks.ts';",
  });
  try {
    assert.deepEqual(
      check(root, { brain: ['evals'], evals: [] }).map(
        (v) => `${v.file}:${v.line} ${v.edge}`,
      ),
      ['src/brain/x.ts:2 brain -> root:evals'],
    );
    assert.deepEqual(
      check(root, { brain: ['evals', 'root:evals'], evals: [] }),
      [],
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

test('the repository obeys the binary allowlist, and a new gh spawn outside it fails', () => {
  assert.deepEqual(checkBinaries(repo), []);
  const root = fixture({
    'src/ci/new.ts': "spawnSync('gh', ['api', 'x']);",
    'src/repo/gh.ts': "spawnSync('gh', ['api', 'x']);",
    'src/cli/lane.ts': "spawnSync(\n  'git', ['status']);",
    'src/cli/other.ts':
      "// spawnSync('gh', [])\nrun('gh', ['pr']);\nspawnSync('herdr', ['status']);",
  });
  try {
    assert.deepEqual(
      checkBinaries(root, BINARIES).map((v) => `${v.file}:${v.binary}`),
      ['src/ci/new.ts:gh', 'src/cli/other.ts:gh', 'src/cli/other.ts:herdr'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the layer map names no removed area or unused edge', () => {
  assert.equal('hosts' in LAYERS, false);
  assert.deepEqual(LAYERS.evals, []);
  assert.equal(LAYERS.brain?.includes('cli'), false);
  assert.equal(LAYERS.brain?.includes('evals/fr40/tasks.ts'), false);
});

test('product never imports workshop, except the listed edges, which may only shrink', () => {
  const root = fixture({
    'src/successor/x.ts': 'export const x = 1;',
    'src/task/y.ts': "import { x } from '../successor/x.ts';",
  });
  const layers = { ...LAYERS, task: [...(LAYERS.task ?? []), 'successor'] };
  const found = check(root, layers);
  assert.equal(found.length, 1);
  assert.match(found[0]?.edge ?? '', /product never imports workshop/u);
  for (const edge of PRODUCT_WORKSHOP_EXCEPTIONS) {
    const [file] = edge.split(' -> ');
    assert.ok(file && existsSync(join(repo, file)), `${edge} still exists`);
  }
});

test('tasks/, the record files and lane manifests are named in code only by their owner', () => {
  const root = fixture({
    'src/task/own.ts': "export const own = 'tasks/t-1.json';",
    'src/brain/own.ts': "export const own = '.agents/records.json';",
    'src/hook/bad.ts':
      "export const a = 'tasks/t-1.json';\nexport const b = `standards/records.json`;",
    'src/hook/prose.ts':
      "// 'tasks/x.json' in a comment\nexport const p = 'the `tasks/<id>.json` file';",
    'src/lane/manifest.ts': "export const dir = '.krn/runs/lanes';",
    'src/cli/lane.ts': "export const m = '.krn/runs/lanes/x-abcdef.json';",
  });
  const found = checkStores(root);
  assert.deepEqual(
    found.map((v) => `${v.file}:${v.line}`),
    ['src/cli/lane.ts:1', 'src/hook/bad.ts:1', 'src/hook/bad.ts:2'],
  );
  assert.deepEqual(checkStores(repo), []);
});

test('the pending ref writers are named only by the task storage owner and its helper', () => {
  const root = fixture({
    'src/task/storage.ts': 'addPendingTask(); takePendingTask();',
    'src/task/pending.ts': 'export function addPendingTask() {}',
    'src/task/cli.ts':
      "// addPendingTask in a comment\nimport { removePendingTasks } from './pending.ts';",
    'src/cli/lane.ts': 'commitPendingRecords();',
    'src/cli/read.ts': 'pendingTaskFiles();',
    'src/cli/text.ts': "export const m = 'addPendingTask failed';",
  });
  assert.deepEqual(
    checkWriters(root).map((v) => `${v.file}:${v.line}`),
    ['src/cli/lane.ts:1', 'src/task/cli.ts:2'],
  );
  assert.deepEqual(checkWriters(repo), []);
});
