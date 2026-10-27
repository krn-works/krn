import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, parse, relative, sep } from 'node:path';
import { z } from 'zod';
import { CliUsageError } from '../cli/usage-error.ts';
import {
  EvalDataError,
  type ExperimentManifest,
  loadManifest,
} from './manifest.ts';
import { planExperiment } from './plan.ts';

const blindedId = z.string().regex(/^[a-f0-9]{12}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const leakageFlagSchema = z.strictObject({
  file: z.string().min(1),
  kind: z.enum([
    'packet-ngram',
    'control-ngram',
    'run-path',
    'slot-path',
    'exemplar-sha',
    'co-author',
    'model',
    'harness',
  ]),
});
const entrySchema = z.strictObject({
  runId: hash,
  task: z.string().min(1),
  replica: z.number().int().positive(),
  arm: z.enum(['A', 'B', 'C', 'R']),
  candidateTreeSha: z.string().regex(/^[a-f0-9]{40}$/u),
  flags: z.array(leakageFlagSchema),
});
export type LedgerEntry = z.infer<typeof entrySchema>;
const hashes = z
  .unknown()
  .refine(
    (value) =>
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, '__proto__'),
  )
  .pipe(z.record(blindedId, hash));
const sealSchema = z.strictObject({ entries: hashes });
const unblindedSchema = z.strictObject({ entries: hashes, verdicts: hashes });
const verdictSchema = z.strictObject({
  blindedId,
  verdict: z.enum(['PASS', 'FAIL', 'INCOMPLETE']),
});

export async function dataOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof EvalDataError || error instanceof CliUsageError)
      throw error;
    throw new EvalDataError(
      error instanceof Error ? error.message : String(error),
    );
  }
}
export function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

// Inspect the original spelling before normalization: link/../target must not
// hide a symlink. Missing components are allowed only for owned destinations.
export async function directoryPath(
  path: string,
  allowMissing = false,
): Promise<string> {
  if (!path || path.includes('\0') || path.includes('\\'))
    throw new EvalDataError('invalid directory path');
  const absolute = isAbsolute(path);
  let current = absolute ? parse(path).root : process.cwd();
  for (const part of path
    .slice(absolute ? current.length : 0)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new EvalDataError(`${current}: symlinks are not allowed`);
      if (!info.isDirectory())
        throw new EvalDataError(`${current}: expected a directory`);
    } catch (error) {
      if (!(allowMissing && missing(error))) throw error;
    }
  }
  return current;
}
export function inside(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return (
    child === '' ||
    (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
  );
}
export function overlaps(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left);
}
export async function regularBytes(path: string): Promise<Buffer> {
  // Callers own an already inspected parent directory.
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new EvalDataError(
      `${path}: expected a regular file without symlinks`,
    );
  return readFile(path);
}
function json<T>(bytes: Buffer, schema: z.ZodType<T>, role: string): T {
  try {
    // Hash raw bytes; accept JSON CRLF whitespace, refuse BOM and invalid UTF-8.
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    const result = schema.safeParse(value);
    if (!result.success) throw new Error('schema mismatch');
    return result.data;
  } catch {
    throw new EvalDataError(`${role}: invalid UTF-8 JSON or schema`);
  }
}
function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function candidateId(key: Buffer, runId: string): string {
  return createHmac('sha256', key).update(runId).digest('hex').slice(0, 12);
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

export async function withLedger<T>(
  manifest: ExperimentManifest,
  options: { root: string; experiment: string },
  create: boolean,
  operation: (ledger: { path: string; key: Buffer }) => Promise<T>,
): Promise<T> {
  return dataOperation(async () => {
    const experiment = await directoryPath(options.experiment);
    const root = await directoryPath(options.root, create);
    if (overlaps(root, experiment))
      throw new EvalDataError('ledger root overlaps experiment');
    const path = await directoryPath(join(root, manifest.id, 'ledger'), create);
    let fresh = false;
    if (create && !(await exists(path))) {
      await mkdir(join(root, manifest.id), { recursive: true });
      await mkdir(path, { mode: 0o700 });
      fresh = true;
    }
    await mkdir(join(path, '.lock'));
    try {
      if (fresh) {
        await writeFile(join(path, 'key'), randomBytes(32), {
          flag: 'wx',
          mode: 0o600,
        });
        await mkdir(join(path, 'entries'), { mode: 0o700 });
      }
      const keyPath = join(path, 'key');
      const key = await regularBytes(keyPath);
      if (key.length !== 32 || ((await lstat(keyPath)).mode & 0o777) !== 0o600)
        throw new EvalDataError(
          'ledger key requires 32 bytes and permissions 0600',
        );
      await directoryPath(join(path, 'entries'));
      return await operation({ path, key });
    } finally {
      await rmdir(join(path, '.lock'));
    }
  });
}

export async function ledgerState(
  manifest: ExperimentManifest,
  ledger: { path: string; key: Buffer },
) {
  const sealPath = join(ledger.path, 'sealed.json');
  const seal = (await exists(sealPath))
    ? json(await regularBytes(sealPath), sealSchema, 'seal')
    : undefined;
  const names = (await readdir(join(ledger.path, 'entries'))).sort();
  const entries = [];
  const entryHashes: Record<string, string> = {};
  const runs = planExperiment(manifest, { draft: true }).runs;
  const seen = new Set<string>();
  for (const name of names) {
    if (!/^[a-f0-9]{12}\.json$/u.test(name))
      throw new EvalDataError('unexpected ledger entry name');
    const id = name.slice(0, 12);
    const bytes = await regularBytes(join(ledger.path, 'entries', name));
    entryHashes[id] = digest(bytes);
    if (seal && seal.entries[id] !== entryHashes[id])
      throw new EvalDataError('sealed entry hash changed');
    const entry = json(bytes, entrySchema, 'ledger entry');
    const run = runs.find((run) => run.runId === entry.runId);
    if (
      !run ||
      run.task !== entry.task ||
      run.replica !== entry.replica ||
      run.arm !== entry.arm ||
      candidateId(ledger.key, entry.runId) !== id ||
      seen.has(entry.runId)
    )
      throw new EvalDataError('ledger entry assignment mismatch');
    seen.add(entry.runId);
    entries.push({ blindedId: id, ...entry });
  }
  if (seal && JSON.stringify(seal.entries) !== JSON.stringify(entryHashes))
    throw new EvalDataError('sealed entry set changed');
  return { entries, hashes: entryHashes, sealed: seal !== undefined };
}

export const blindUsage =
  'usage: krn eval blind --experiment <dir> --root <dir> --run <runId> --candidate <repo dir> --out <dir> [--draft] [--json]';
const ledgerUsage =
  'usage: krn eval ledger seal|show|unblind --experiment <dir> --root <dir> [--json]';
export function parseOptions(
  args: string[],
  required: string[],
  switches: string[],
  usage: string,
) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === undefined || ![...required, ...switches].includes(name))
      throw new CliUsageError(`unknown option ${name}; ${usage}`);
    if (values.has(name))
      throw new CliUsageError(`${name} may be supplied once`);
    if (switches.includes(name)) {
      values.set(name, 'true');
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--'))
      throw new CliUsageError(`missing value for ${name}; ${usage}`);
    values.set(name, value);
  }
  for (const name of required)
    if (!values.has(name)) throw new CliUsageError(usage);
  return (name: string): string => values.get(name) ?? '';
}

export async function ledgerCommand(args: string[]): Promise<void> {
  const action = args[0];
  if (action !== 'seal' && action !== 'show' && action !== 'unblind')
    throw new CliUsageError(ledgerUsage);
  const option = parseOptions(
    args.slice(1),
    ['--experiment', '--root'],
    ['--json'],
    ledgerUsage,
  );
  const options = {
    experiment: option('--experiment'),
    root: option('--root'),
  };
  const manifest = await loadManifest(options.experiment);
  const result = await withLedger(manifest, options, false, async (ledger) => {
    const state = await ledgerState(manifest, ledger);
    if (action === 'show')
      return {
        candidates: state.entries.map(({ blindedId, task }) => ({
          blindedId,
          task,
        })),
      };
    if (state.entries.length === 0)
      throw new EvalDataError('cannot seal or unblind an empty ledger');
    if (action === 'seal') {
      if (!state.sealed)
        await writeJson(join(ledger.path, 'sealed.json'), {
          entries: state.hashes,
        });
      return {
        sealed: true,
        blindedIds: state.entries.map((entry) => entry.blindedId),
      };
    }
    if (!state.sealed)
      throw new EvalDataError('ledger must be sealed before unblinding');
    const verdictDirectory = await directoryPath(join(ledger.path, 'verdicts'));
    const names = (await readdir(verdictDirectory)).sort();
    if (
      JSON.stringify(names) !==
      JSON.stringify(state.entries.map((entry) => `${entry.blindedId}.json`))
    )
      throw new EvalDataError('one verdict file per blinded id is required');
    const verdictHashes: Record<string, string> = {};
    for (const entry of state.entries) {
      const bytes = await regularBytes(
        join(verdictDirectory, `${entry.blindedId}.json`),
      );
      const verdict = json(bytes, verdictSchema, 'verdict');
      if (verdict.blindedId !== entry.blindedId)
        throw new EvalDataError('verdict blindedId mismatch');
      verdictHashes[entry.blindedId] = digest(bytes);
    }
    const record = { entries: state.hashes, verdicts: verdictHashes };
    const path = join(ledger.path, 'unblinded.json');
    if (await exists(path)) {
      if (
        JSON.stringify(
          json(await regularBytes(path), unblindedSchema, 'unblinded record'),
        ) !== JSON.stringify(record)
      )
        throw new EvalDataError('unblinded entries or verdicts changed');
    } else await writeJson(path, record);
    return { candidates: state.entries };
  });
  process.stdout.write(
    option('--json')
      ? `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`
      : 'candidates' in result
        ? `${result.candidates.map((entry) => JSON.stringify(entry)).join('\n')}\n`
        : `${result.blindedIds.join('\n')}\n`,
  );
}
