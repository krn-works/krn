// Adoption census (logic: src/adopt/census.ts). Usage: KRN_CENSUS_CODING=<dir> TMPDIR=<disk dir> node scripts/adoption-census.ts [--write]
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCensus } from '../src/adopt/census.ts';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const coding = process.env.KRN_CENSUS_CODING ?? '';
  if (coding === '') {
    process.stderr.write(
      'set KRN_CENSUS_CODING to the directory holding the census repositories, and TMPDIR to a disk path\n',
    );
    process.exit(64);
  }
  const table = runCensus({
    coding,
    scratch: join(tmpdir(), 'krn-adoption-census'),
    repoRoot,
  });
  if (process.argv.includes('--write'))
    writeFileSync(join(repoRoot, 'evals/adoption-census.md'), table);
  else process.stdout.write(table);
}
