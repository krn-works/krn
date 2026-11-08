import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const biome = createRequire(import.meta.url).resolve(
  '@biomejs/biome/bin/biome',
);
const clean =
  "import { join } from 'node:path';\n\nexport const a = join('a');\n";

// Lints one seeded file under the repository's Biome config, as `npm run lint` does.
function lint(source: string): number | null {
  const dir = mkdtempSync(join(tmpdir(), 'krn-lint-warnings-'));
  try {
    const config = JSON.parse(
      readFileSync(join(repository, 'biome.json'), 'utf8'),
    ) as Record<string, unknown>;
    config.vcs = { enabled: false };
    config.files = { includes: ['**'] };
    writeFileSync(join(dir, 'biome.json'), JSON.stringify(config));
    writeFileSync(join(dir, 'seeded.ts'), source);
    return spawnSync(
      process.execPath,
      [biome, 'check', '--error-on-warnings', 'seeded.ts'],
      { cwd: dir, encoding: 'utf8' },
    ).status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('npm run lint fails on Biome warnings', () => {
  const manifest = JSON.parse(
    readFileSync(join(repository, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  assert.match(
    manifest.scripts.lint ?? '',
    /biome check --error-on-warnings /u,
  );
});

test('a clean file passes the lint check', () => {
  assert.equal(lint(clean), 0);
});

test('a seeded unused import fails the lint check', () => {
  assert.notEqual(lint(`import { sep } from 'node:path';\n${clean}`), 0);
});

test('a seeded unused suppression fails the lint check', () => {
  assert.notEqual(
    lint(`// biome-ignore lint/suspicious/noExplicitAny: seeded\n${clean}`),
    0,
  );
});
