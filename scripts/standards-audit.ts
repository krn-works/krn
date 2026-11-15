// Per-record applies/pass table of the shipped standards pack over adopted repositories (read-only on them).
// Usage: node scripts/standards-audit.ts ROW_DIR... > evals/standards-audit.md
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const cli = join(repoRoot, 'src/cli/main.ts');
const rows = process.argv.slice(2);
if (rows.length === 0) {
  process.stderr.write('usage: standards-audit.ts ROW_DIR...\n');
  process.exit(64);
}
const pack = JSON.parse(
  readFileSync(join(repoRoot, 'standards/records.json'), 'utf8'),
) as { id: string; enforcement: { kind: string } }[];

type Cell = 'pass' | 'FAIL' | 'n/a' | 'advisory';
function cell(record: (typeof pack)[number], row: string): Cell {
  const done = spawnSync(
    process.execPath,
    [cli, 'standards', 'check', '--root', row, '--record', record.id],
    { encoding: 'utf8' },
  );
  if (/not found/u.test(done.stdout + done.stderr)) return 'n/a';
  if (record.enforcement.kind === 'advisory') return 'advisory';
  return done.status === 0 ? 'pass' : 'FAIL';
}

const lines = [
  `| record | ${rows.map((row) => basename(row)).join(' | ')} |`,
  `| --- | ${rows.map(() => '---').join(' | ')} |`,
];
const reds = new Map<string, number>();
for (const record of pack) {
  const cells = rows.map((row) => cell(record, row));
  for (const [index, value] of cells.entries())
    if (value === 'FAIL')
      reds.set(
        rows[index] as string,
        (reds.get(rows[index] as string) ?? 0) + 1,
      );
  lines.push(`| ${record.id} | ${cells.join(' | ')} |`);
}
lines.push(
  '',
  `FAIL cells per row: ${rows.map((row) => `${basename(row)}=${reds.get(row) ?? 0}`).join(', ')}`,
);
process.stdout.write(`${lines.join('\n')}\n`);
