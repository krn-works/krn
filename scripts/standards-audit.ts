// Per-record applies/pass table of the shipped standards pack over adopted repositories (read-only on them).
// Usage: node scripts/standards-audit.ts ROW_DIR... > evals/standards-audit.md
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const cli = join(repoRoot, 'src/cli/main.ts');
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
type PackRecord = { id: string; enforcement: { kind: string } };

/**
 * A full adoption of a row: a throwaway clone that `krn adopt` has written (Stop hook, `.krn` ignore, session
 * settings, instruction files), with the test command taken from the row's krn.json. The row itself is untouched.
 * Returns the clone directory, or the adopt output as an error when adoption refuses.
 */
export function adoptedCopy(
  row: string,
  scratch = mkdtempSync(join(process.env.KRN_AUDIT_TMP ?? tmpdir(), 'audit-')),
): { dir: string } | { error: string } {
  const dir = join(scratch, basename(row));
  const cloned = spawnSync('git', ['clone', '--quiet', row, dir], {
    encoding: 'utf8',
  });
  if (cloned.status !== 0) return { error: cloned.stderr };
  const configPath = join(dir, 'krn.json');
  const config = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as { test?: string })
    : {};
  const args = [cli, 'adopt', dir, '--tracker'];
  if (config.test !== undefined) args.push('--test', config.test);
  const adopted = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return adopted.status === 0
    ? { dir }
    : { error: adopted.stdout + adopted.stderr };
}

type Cell = 'pass' | 'FAIL' | 'n/a' | 'advisory';
function cell(record: PackRecord, row: string): Cell {
  const done = spawnSync(
    process.execPath,
    [cli, 'standards', 'check', '--root', row, '--record', record.id],
    { encoding: 'utf8' },
  );
  if (/not found/u.test(done.stdout + done.stderr)) return 'n/a';
  if (record.enforcement.kind === 'advisory') return 'advisory';
  return done.status === 0 ? 'pass' : 'FAIL';
}

function main(rows: string[]): void {
  const pack = JSON.parse(
    readFileSync(join(repoRoot, 'standards/records.json'), 'utf8'),
  ) as PackRecord[];
  const adopted = rows.map((row) => {
    const copy = adoptedCopy(row);
    if ('error' in copy) {
      process.stderr.write(
        `standards-audit: ${row}: adopt refused: ${copy.error}\n`,
      );
      process.exit(1);
    }
    return copy.dir;
  });
  const lines = [
    `| record | ${rows.map((row) => basename(row)).join(' | ')} |`,
    `| --- | ${rows.map(() => '---').join(' | ')} |`,
  ];
  const reds = new Map<string, number>();
  for (const record of pack) {
    const cells = adopted.map((row) => cell(record, row));
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
}

if (isMain) {
  const rows = process.argv.slice(2);
  if (rows.length === 0) {
    process.stderr.write('usage: standards-audit.ts ROW_DIR...\n');
    process.exit(64);
  }
  main(rows);
}
