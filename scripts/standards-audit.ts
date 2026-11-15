// Per-record applies/pass table of the shipped standards pack over adopted repositories (read-only on them).
// Usage: node scripts/standards-audit.ts ROW_DIR... > evals/standards-audit.md
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appliesTo,
  checkStandards,
  type Standard,
} from '../src/brain/standards.ts';
import {
  ENFORCEMENT_TIMEOUT_MS,
  enforcer,
  readPack,
  repositoryFacts,
} from '../src/brain/standards-cli.ts';
import {
  PLANTS,
  type Plant,
  REQUIRES_TOOL,
  type Stack,
} from './lib/record-plants.ts';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const cli = join(repoRoot, 'src/cli/main.ts');
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
type PackRecord = { id: string; enforcement: { kind: string } };

/** The environment of an adopt run: its registry is a scratch file, never the host's `~/.krn/adopted.json`. */
export function scratchRegistry(scratch: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KRN_ADOPTED_REGISTRY: join(scratch, 'registry.json'),
  };
}

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
  const adopted = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: scratchRegistry(scratch),
  });
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

export const INIT_STACK_NAMES: readonly Stack[] = [
  'ts',
  'python',
  'go',
  'php',
  'wp-plugin',
];

export type Bite = {
  stack: Stack;
  id: string;
  /** `bites` is the only passing status. */
  status:
    | 'bites'
    | 'tool-absent'
    | 'no-plant'
    | 'red-at-baseline'
    | 'stays-green'
    | 'unnamed'
    | 'stays-red';
  detail: string;
};

const identity = [
  '-c',
  'user.name=planted',
  '-c',
  'user.email=planted@example.com',
];

function git(dir: string, args: string[]): string {
  const done = spawnSync('git', [...identity, ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (done.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout;
}

/** A project born by `krn adopt --init` for the stack, adopted with the tracker and committed. */
export function initProject(stack: Stack, scratch: string): string {
  const dir = join(scratch, stack);
  mkdirSync(dir, { recursive: true });
  const done = spawnSync(
    process.execPath,
    [cli, 'adopt', dir, '--init', '--stack', stack, '--tracker'],
    { encoding: 'utf8', env: scratchRegistry(scratch) },
  );
  if (done.status !== 0)
    throw new Error(`adopt --init ${stack}: ${done.stdout}${done.stderr}`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'chore: adopt krn']);
  return dir;
}

function plantInto(dir: string, stack: Stack, plant: Plant): void {
  const files = git(dir, ['ls-files']).split('\n').filter(Boolean);
  const edit = plant({ dir, stack, files });
  const written = Object.entries(edit.write ?? {});
  for (const [name, content] of written) {
    if (content === null) rmSync(join(dir, name), { force: true });
    else {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
  }
  git(dir, ['add', '-A']);
  for (const [name, content] of written)
    if (content !== null) git(dir, ['add', '-f', '--', name]);
  for (const name of edit.untrack ?? [])
    git(dir, ['rm', '--cached', '-q', '--', name]);
  if (edit.commit !== undefined) git(dir, ['commit', '-qm', edit.commit]);
}

/** The enforcement of one record alone, as the check judges it: failures name the record and its remedy. */
function judge(dir: string, record: Standard, asOf: string) {
  return checkStandards([record], {
    asOf,
    enforce: enforcer(dir, ENFORCEMENT_TIMEOUT_MS),
  });
}

/**
 * Every enforced pack record that applies to a fresh project of the stack: plant its violation and
 * require a red verdict naming the record and its remedy, then a green one after the revert.
 */
export function plantedMatrix(
  stack: Stack,
  scratch: string,
  plants: Record<string, Plant> = PLANTS,
): Bite[] {
  const dir = initProject(stack, scratch);
  const asOf = new Date().toISOString().slice(0, 10);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();
  const facts = repositoryFacts(dir);
  const records = readPack().filter(
    (record: Standard) =>
      record.enforcement.kind !== 'advisory' && appliesTo(record, facts),
  );
  const revert = () => {
    git(dir, ['reset', '--hard', '-q', base]);
    git(dir, ['clean', '-fdq']);
  };
  const results: Bite[] = [];
  for (const record of records) {
    const { id } = record;
    const done = (status: Bite['status'], detail = ''): void => {
      results.push({ stack, id, status, detail });
    };
    const plant = plants[id];
    if (plant === undefined) {
      done('no-plant', 'add an entry to scripts/lib/record-plants.ts');
      continue;
    }
    const tool = REQUIRES_TOOL[id];
    if (
      tool !== undefined &&
      spawnSync(tool, ['-l'], { input: 'package p\n', encoding: 'utf8' })
        .status !== 0
    ) {
      done('tool-absent', `${tool} is not installed`);
      continue;
    }
    if (judge(dir, record, asOf).failures.length > 0) {
      done('red-at-baseline');
      continue;
    }
    plantInto(dir, stack, plant);
    const red = judge(dir, record, asOf).failures;
    revert();
    const green = judge(dir, record, asOf).failures;
    if (red.length === 0) done('stays-green');
    else if (
      red[0]?.id !== id ||
      red[0].remedy !== record.text ||
      record.text === ''
    )
      done('unnamed', `remedy ${String(red[0]?.remedy)}`);
    else if (green.length > 0) done('stays-red', green[0]?.message ?? '');
    else done('bites');
  }
  return results;
}

/** The report line `N/N records bite` over every stack's results, then one line per failure. */
export function biteReport(results: readonly Bite[]): string {
  const skipped = results.filter((r) => r.status === 'tool-absent');
  const counted = results.filter((r) => r.status !== 'tool-absent');
  const bites = counted.filter((r) => r.status === 'bites').length;
  const lines = counted
    .filter((r) => r.status !== 'bites')
    .map((r) => `${r.stack} ${r.id}: ${r.status} ${r.detail}`);
  const note =
    skipped.length === 0
      ? ''
      : ` (${skipped.length} skipped, tool absent: ${skipped.map((r) => `${r.stack} ${r.id}`).join(', ')})`;
  return [...lines, `${bites}/${counted.length} records bite${note}`].join(
    '\n',
  );
}

if (isMain && process.argv[2] === '--planted') {
  const scratch = mkdtempSync(
    join(process.env.KRN_AUDIT_TMP ?? tmpdir(), 'planted-'),
  );
  const named = process.argv[3] as Stack | undefined;
  const results = INIT_STACK_NAMES.filter(
    (stack) => named === undefined || stack === named,
  ).flatMap((stack) => plantedMatrix(stack, scratch));
  process.stdout.write(`${biteReport(results)}\n`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(
    results.every((r) => r.status === 'bites' || r.status === 'tool-absent')
      ? 0
      : 1,
  );
}

if (isMain) {
  const rows = process.argv.slice(2);
  if (rows.length === 0) {
    process.stderr.write('usage: standards-audit.ts ROW_DIR...\n');
    process.exit(64);
  }
  main(rows);
}
