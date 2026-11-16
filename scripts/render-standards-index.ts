// Writes or checks the standards index of the standards skill (logic: src/brain/standards-index.ts).
// Usage: node scripts/render-standards-index.ts --write | --check
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStandards } from '../src/brain/standards.ts';
import { renderStandardsIndex } from '../src/brain/standards-index.ts';

const repository = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The installer source and the copy this repository reads: identical bytes. */
export const INDEX_FILES = [
  'src/adopt/skills/standards/INDEX.md',
  '.agents/skills/standards/INDEX.md',
] as const;

export function expectedIndex(root: string): string {
  const pack = parseStandards(
    JSON.parse(readFileSync(join(root, 'standards/records.json'), 'utf8')),
  );
  return renderStandardsIndex(pack);
}

function read(root: string, file: string): string {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return '';
  }
}

/** The index files of `root` that differ from the pack's index; none when `root` has no pack or skill. */
export function staleIndexFiles(root: string): string[] {
  if (!existsSync(join(root, 'standards/records.json'))) return [];
  const expected = expectedIndex(root);
  return INDEX_FILES.filter(
    (file) =>
      existsSync(dirname(join(root, file))) && read(root, file) !== expected,
  );
}

/** Rewrites the stale index files of `root`; the files it wrote. */
export function refreshIndex(root: string): string[] {
  const stale = staleIndexFiles(root);
  if (stale.length === 0) return stale;
  const expected = expectedIndex(root);
  for (const file of stale) writeFileSync(join(root, file), expected);
  return stale;
}

export function main(argv: readonly string[]): number {
  const mode = argv[0];
  if ((mode !== '--write' && mode !== '--check') || argv.length !== 1) {
    process.stderr.write(
      'usage: node scripts/render-standards-index.ts --write | --check\n',
    );
    return 64;
  }
  if (mode === '--check') {
    const stale = staleIndexFiles(repository);
    for (const file of stale)
      process.stderr.write(
        `${file} is stale; run node scripts/render-standards-index.ts --write\n`,
      );
    return stale.length === 0 ? 0 : 1;
  }
  refreshIndex(repository);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
