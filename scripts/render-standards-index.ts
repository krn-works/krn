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
/** The index of the repository's own records; it is not shipped. */
export const OWN_INDEX_FILE = '.agents/skills/standards/OWN-INDEX.md';
const OWN_RECORDS = '.agents/standards.json';
const PACK_RECORDS = 'standards/records.json';

function records(root: string, file: string) {
  return parseStandards(JSON.parse(readFileSync(join(root, file), 'utf8')));
}

/** The generated files of `root` with their expected bytes: the pack index and the own-records index, each only when its source exists. */
export function expectedFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const skill = existsSync(join(root, dirname(OWN_INDEX_FILE)));
  if (existsSync(join(root, PACK_RECORDS))) {
    const pack = renderStandardsIndex(records(root, PACK_RECORDS));
    for (const file of INDEX_FILES)
      if (existsSync(dirname(join(root, file)))) files.set(file, pack);
  }
  if (skill && existsSync(join(root, OWN_RECORDS)))
    files.set(
      OWN_INDEX_FILE,
      renderStandardsIndex(records(root, OWN_RECORDS), 'own'),
    );
  return files;
}

function read(root: string, file: string): string {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return '';
  }
}

/** The generated files of `root` that differ from their expected bytes. */
export function staleIndexFiles(root: string): string[] {
  return [...expectedFiles(root)]
    .filter(([file, bytes]) => read(root, file) !== bytes)
    .map(([file]) => file);
}

/** Rewrites the stale index files of `root`; the files it wrote. */
export function refreshIndex(root: string): string[] {
  const expected = expectedFiles(root);
  const stale = [...expected].filter(
    ([file, bytes]) => read(root, file) !== bytes,
  );
  for (const [file, bytes] of stale) writeFileSync(join(root, file), bytes);
  return stale.map(([file]) => file);
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
