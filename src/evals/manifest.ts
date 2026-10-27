import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, parse, sep, win32 } from 'node:path';
import { z } from 'zod';

export class EvalDataError extends Error {
  readonly exitCode = 65;
}

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const label = z
  .string()
  .min(1)
  .refine((value) => value.trim() !== '' && !value.includes('\0'));
const inputPath = z
  .string()
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !win32.isAbsolute(value) &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    'input must be a relative path inside the experiment, without .. segments',
  );
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
// Zod skips this record key before validating it. Inspect the raw map so an
// input cannot disappear from the set whose paths and hashes we validate.
const inputs = z
  .unknown()
  .refine(
    (value) =>
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, '__proto__'),
    'reserved input path',
  )
  .pipe(z.record(inputPath, sha256));
const gitSha = z.string().regex(/^[a-f0-9]{40}$/u);
const argv = z
  .array(z.string().refine((value) => !value.includes('\0')))
  .min(1)
  .refine(
    (value) => value[0]?.trim() !== '',
    'check argv requires an executable',
  );
const arm = z.strictObject({
  id: z.enum(['A', 'B', 'C', 'R']),
  model: label,
  harness: label,
  material: z.enum(['none', 'packet', 'control']),
});
const task = z.strictObject({
  id: identifier,
  repository: label,
  baseSha: gitSha,
  exemplarSha: gitSha,
  packet: inputPath,
  control: inputPath,
  contract: inputPath,
  checklist: inputPath,
  focusedCheck: argv,
  suiteChecks: z.array(argv).min(1),
});

export const manifestSchema = z
  .strictObject({
    id: identifier,
    frozen: z.boolean(),
    seed: label,
    replicas: z.number().int().min(1),
    arms: z.array(arm),
    tasks: z.array(task).min(1),
    inputs,
  })
  .superRefine((manifest, context) => {
    for (const [role, values] of [
      ['arm', manifest.arms],
      ['task', manifest.tasks],
    ] as const) {
      const ids = values.map((value) => value.id);
      if (new Set(ids).size !== ids.length)
        context.addIssue({ code: 'custom', message: `duplicate ${role} id` });
    }
    if (new Set(manifest.arms.map((value) => value.id)).size !== 4)
      context.addIssue({
        code: 'custom',
        message: 'every task requires all four arms A, B, C, R',
      });
    for (const value of manifest.arms) {
      const expected =
        value.id === 'B' ? 'packet' : value.id === 'C' ? 'control' : 'none';
      if (value.material !== expected)
        context.addIssue({
          code: 'custom',
          message: `arm ${value.id} material must be ${expected}`,
        });
    }
    for (const value of manifest.tasks) {
      for (const path of [
        value.packet,
        value.control,
        value.contract,
        value.checklist,
      ]) {
        if (!Object.hasOwn(manifest.inputs, path))
          context.addIssue({
            code: 'custom',
            message: `${path} must be listed in inputs`,
          });
      }
    }
  });

export type ExperimentManifest = z.infer<typeof manifestSchema>;

async function inspectExperimentDirectory(path: string): Promise<string> {
  const absolute = isAbsolute(path);
  let current = absolute ? parse(path).root : process.cwd();
  const components = path
    .slice(absolute ? current.length : 0)
    .split(sep)
    .filter((component) => component !== '');
  if (components.length === 0) components.push('.');
  try {
    for (const component of components) {
      current = join(current, component);
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new EvalDataError(
          `experiment path component "${current}": symlinks are not allowed`,
        );
      if (!stat.isDirectory())
        throw new EvalDataError(
          `experiment path component "${current}": expected a directory`,
        );
    }
    return current;
  } catch (error) {
    if (error instanceof EvalDataError) throw error;
    throw new EvalDataError(
      `experiment directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Paths use portable, relative POSIX segments. Inspect every component so a
// symlinked parent directory cannot turn an otherwise relative input external.
async function readExperimentFile(root: string, path: string): Promise<Buffer> {
  try {
    let current = root;
    const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new EvalDataError(`${path}: symlinks are not allowed`);
      if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
        throw new EvalDataError(
          `${path}: expected a regular file inside the experiment`,
        );
    }
    return await readFile(current);
  } catch (error) {
    if (error instanceof EvalDataError) throw error;
    throw new EvalDataError(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function utf8(bytes: Buffer, path: string): string {
  try {
    // Preserve BOM, CRLF and all other characters; never normalize hashed input.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new EvalDataError(`${path}: invalid UTF-8`);
  }
}

export async function loadManifest(
  experimentDirectory: string,
): Promise<ExperimentManifest> {
  const root = await inspectExperimentDirectory(experimentDirectory);
  const json = utf8(
    await readExperimentFile(root, 'manifest.json'),
    'manifest.json',
  );
  let value: unknown;
  try {
    // JSON whitespace may include CRLF. A leading BOM is not JSON and is refused.
    value = JSON.parse(json);
  } catch {
    throw new EvalDataError(
      'manifest.json: invalid JSON (UTF-8 without BOM required)',
    );
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success)
    throw new EvalDataError(`manifest.json: ${parsed.error.message}`);
  const manifest = parsed.data;
  const materials = new Set(
    manifest.tasks.flatMap((value) => [value.packet, value.control]),
  );
  const characters = new Map<string, number>();
  for (const [path, expected] of Object.entries(manifest.inputs)) {
    const bytes = await readExperimentFile(root, path);
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw new EvalDataError(`${path}: sha256 mismatch`);
    // Count Unicode code points, including headings, citations and newlines.
    if (materials.has(path))
      characters.set(path, Array.from(utf8(bytes, path)).length);
  }
  for (const value of manifest.tasks) {
    const packet = characters.get(value.packet);
    const control = characters.get(value.control);
    if (packet === undefined || control === undefined)
      throw new EvalDataError(
        `${value.id}: packet and control must be listed in inputs`,
      );
    if (Math.ceil(packet / 4) > 2000)
      throw new EvalDataError(
        `${value.packet}: exceeds 2000 estimated tokens (ceil(characters/4))`,
      );
    if (packet !== control)
      throw new EvalDataError(
        `${value.control}: control character count must equal packet character count`,
      );
  }
  return manifest;
}
