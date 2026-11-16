import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  INDEX_FILES,
  refreshIndex,
  staleIndexFiles,
} from '../../scripts/render-standards-index.ts';
import { parseStandards } from '../../src/brain/standards.ts';
import {
  enforcedRecords,
  INDEX_BUDGET_BYTES,
  renderStandardsIndex,
} from '../../src/brain/standards-index.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'src/cli/main.ts');
const pack = parseStandards(
  JSON.parse(readFileSync(join(root, 'standards/records.json'), 'utf8')),
);

function lines(index: string): string[] {
  return index
    .split('\n')
    .filter((line) => /^s-[a-z0-9-]+( \[|: )/u.test(line));
}

test('the index has one line per enforced pack record, under the byte budget', () => {
  const index = renderStandardsIndex(pack);
  const enforced = enforcedRecords(pack);
  assert.ok(enforced.length > 0);
  assert.equal(lines(index).length, enforced.length);
  for (const record of enforced)
    assert.ok(
      lines(index).some((line) => line.startsWith(`${record.id}`)),
      record.id,
    );
  assert.ok(Buffer.byteLength(index) <= INDEX_BUDGET_BYTES);
  assert.ok(INDEX_BUDGET_BYTES < 6144);
});

test('a record without an index line is reported by the generator comparison', () => {
  const extra = {
    ...(pack.find((r) => r.enforcement.kind === 'command') as object),
    id: 's-index-new-rule',
  } as (typeof pack)[number];
  const index = renderStandardsIndex([...pack, extra]);
  assert.equal(lines(index).length, enforcedRecords(pack).length + 1);
  assert.ok(lines(index).some((line) => line.startsWith('s-index-new-rule')));
});

test('the committed index files equal the generated index', () => {
  assert.deepEqual(staleIndexFiles(root), []);
  const spawned = spawnSync(
    process.execPath,
    [join(root, 'scripts/render-standards-index.ts'), '--check'],
    { encoding: 'utf8' },
  );
  assert.equal(spawned.status, 0, spawned.stderr);
  const [source, copy] = INDEX_FILES.map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
  assert.equal(source, copy);
});

test('refreshing a repository without a pack changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'standards-index-'));
  try {
    assert.deepEqual(refreshIndex(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('krn adopt ships the index byte for byte in the standards skill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'standards-index-adopt-'));
  try {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: dir,
        encoding: 'utf8',
      });
    assert.equal(
      run('adopt', dir, '--init', '--stack', 'ts', '--no-canary').status,
      0,
    );
    assert.equal(
      readFileSync(join(dir, '.agents/skills/standards/INDEX.md'), 'utf8'),
      readFileSync(join(root, INDEX_FILES[0]), 'utf8'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
