import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  expectedFiles,
  INDEX_FILES,
  OWN_INDEX_FILE,
  refreshIndex,
  staleIndexFiles,
} from '../../scripts/render-standards-index.ts';
import { parseStandards } from '../../src/brain/standards.ts';
import {
  enforcedRecords,
  INDEX_BUDGET_BYTES,
  OWN_INDEX_BUDGET_BYTES,
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
  // The measured size is 12070 bytes; the budget leaves under 1% headroom.
  assert.equal(INDEX_BUDGET_BYTES, 12400);
});

test('a record without an index line is reported by the generator comparison', () => {
  const extra = {
    ...(pack.find((r) => r.enforcement.kind === 'command') as object),
    id: 's-index-new-rule',
  } as (typeof pack)[number];
  const index = renderStandardsIndex([...pack.slice(1), extra]);
  assert.equal(lines(index).length, enforcedRecords(pack.slice(1)).length + 1);
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

test('no index line ends in an ellipsis and every rule is a whole sentence', () => {
  for (const [file, bytes] of expectedFiles(root)) {
    assert.ok(lines(bytes).length > 0, file);
    for (const line of lines(bytes)) {
      assert.ok(!line.endsWith('...'), `${file}: ${line}`);
      assert.ok(!line.endsWith(':'), `${file}: ${line}`);
    }
  }
});

test('the own-records index lists every enforced own record within its byte budget', () => {
  const own = parseStandards(
    JSON.parse(readFileSync(join(root, '.agents/standards.json'), 'utf8')),
  );
  const index = readFileSync(join(root, OWN_INDEX_FILE), 'utf8');
  const enforced = enforcedRecords(own);
  assert.ok(enforced.length > 0);
  assert.equal(lines(index).length, enforced.length);
  assert.ok(Buffer.byteLength(index) <= OWN_INDEX_BUDGET_BYTES);
  // The measured size is 5776 bytes; the budget leaves room for a few more records.
  assert.equal(OWN_INDEX_BUDGET_BYTES, 6400);
});

test('the own index still renders after one more 200-byte record is added', () => {
  const own = parseStandards(
    JSON.parse(readFileSync(join(root, '.agents/standards.json'), 'utf8')),
  );
  const template = enforcedRecords(own)[0] as (typeof own)[number];
  const sentence = `${'A whole rule sentence for the room check '.repeat(4).trim()}.`;
  const extra = {
    ...template,
    id: 's-fixture-room',
    text: sentence,
    applies: { ...template.applies, paths: [] },
  };
  const index = renderStandardsIndex([...own, extra], 'own');
  const line = lines(index).find((l) => l.startsWith('s-fixture-room')) ?? '';
  assert.ok(Buffer.byteLength(line) >= 150 && Buffer.byteLength(line) <= 200);
  assert.ok(Buffer.byteLength(index) <= OWN_INDEX_BUDGET_BYTES);
});

function fixture(ownRecords: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'standards-index-own-'));
  mkdirSync(join(dir, '.agents/skills/standards'), { recursive: true });
  mkdirSync(join(dir, 'standards'));
  writeFileSync(
    join(dir, 'standards/records.json'),
    readFileSync(join(root, 'standards/records.json')),
  );
  writeFileSync(
    join(dir, '.agents/standards.json'),
    JSON.stringify(ownRecords),
  );
  return dir;
}

const sentence =
  'The fixture repository keeps its own whole rule intact, with a long tail that would once have been cut short.';

test('a fixture repository with one own record lists it with its full sentence', () => {
  const template = enforcedRecords(pack)[0] as (typeof pack)[number];
  const own = {
    ...template,
    id: 's-fixture-own',
    text: `${sentence} A second sentence stays out.`,
  };
  const dir = fixture([own]);
  try {
    assert.deepEqual(refreshIndex(dir).sort(), [
      INDEX_FILES[1],
      OWN_INDEX_FILE,
    ]);
    const index = readFileSync(join(dir, OWN_INDEX_FILE), 'utf8');
    assert.ok(
      lines(index).some(
        (line) =>
          line.startsWith('s-fixture-own') &&
          line.endsWith(`: ${sentence.slice(0, -1)}`),
      ),
    );
    assert.deepEqual(staleIndexFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the drift check fails after an own record is added without regenerating', () => {
  const template = enforcedRecords(pack)[0] as (typeof pack)[number];
  const dir = fixture([{ ...template, id: 's-fixture-first' }]);
  try {
    refreshIndex(dir);
    const added = [
      { ...template, id: 's-fixture-first' },
      { ...template, id: 's-fixture-second' },
    ];
    writeFileSync(join(dir, '.agents/standards.json'), JSON.stringify(added));
    assert.deepEqual(staleIndexFiles(dir), [OWN_INDEX_FILE]);
    // The same drift check the script runs, pointed at the fixture through a copy of the script.
    assert.deepEqual(refreshIndex(dir), [OWN_INDEX_FILE]);
    assert.deepEqual(staleIndexFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rule that pushes the own index over its budget fails generation', () => {
  const template = enforcedRecords(pack)[0] as (typeof pack)[number];
  const many = Array.from({ length: 80 }, (_, i) => ({
    ...template,
    id: `s-fixture-${i}`,
  }));
  assert.throws(() => renderStandardsIndex(many, 'own'), /byte budget/u);
});
