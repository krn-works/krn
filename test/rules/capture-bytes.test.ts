import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const fixtures = join(root, 'test/fixtures');

type Ref = { file: string };
type Provenance = { captures: { stdout?: Ref; stderr?: Ref }[] };

/** Every file a test/fixtures/<dir>/provenance.json lists as a verbatim capture. */
function capturedFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(fixtures, { withFileTypes: true })) {
    const manifest = join(fixtures, entry.name, 'provenance.json');
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const { captures } = JSON.parse(
      readFileSync(manifest, 'utf8'),
    ) as Provenance;
    for (const capture of captures)
      for (const ref of [capture.stdout, capture.stderr])
        if (ref) files.push(join(fixtures, entry.name, ref.file));
  }
  return files;
}

/** The biome binary of this checkout, else of the main checkout that shares its git directory. */
function biomeBin(): string {
  const own = join(root, 'node_modules/.bin/biome');
  if (existsSync(own)) return own;
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  return join(dirname(resolve(root, common)), 'node_modules/.bin/biome');
}

test('provenance lists captures to protect', () => {
  assert.ok(capturedFiles().length > 0);
});

test('biome never formats a capture listed in a provenance file', () => {
  const files = capturedFiles().map((file) => file.slice(root.length + 1));
  const run = spawnSync(
    biomeBin(),
    ['format', '--no-errors-on-unmatched', ...files],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  const out = `${run.stdout}${run.stderr}`;
  assert.doesNotMatch(out, /Checked [1-9]\d* files?/u, out);
  assert.match(out, /Checked 0 files|No files were processed/u, out);
});
