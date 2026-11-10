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
const scripts = z
  .unknown()
  .refine(
    (value) =>
      value === null ||
      typeof value !== 'object' ||
      !['__proto__', 'constructor', 'prototype'].some((key) =>
        Object.hasOwn(value, key),
      ),
    'reserved script name',
  )
  .pipe(z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u), label));
const task = z.strictObject({
  id: identifier,
  repository: identifier,
  baseSha: gitSha,
  exemplarSha: gitSha,
  packet: inputPath,
  control: inputPath,
  contract: inputPath,
  checklist: inputPath,
  node: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u),
  workingDirectory: z.union([z.literal('.'), inputPath]),
  scripts,
  focusedCheck: argv,
  suiteChecks: z.array(z.strictObject({ argv, tests: z.boolean() })).min(1),
});

const wozSchema = z
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

type WozManifest = z.infer<typeof wozSchema>;

// FR-40 (ADR 0014 D20): convention tasks in fixed strata (one per template),
// arms A (none), B (brain packet) and S (static standards) at one token budget.
// The check argv is the scorer; {experiment}, {repo}, {task} and {base} are substituted;
// a {base} argument is dropped when the run has no setup commit.
const fr40Arm = z.strictObject({
  id: z.enum(['A', 'B', 'S']),
  model: label,
  harness: label,
  material: z.enum(['none', 'packet', 'standards']),
});
const share = z.number().min(-1).max(1);
const fr40Schema = z
  .strictObject({
    id: identifier,
    design: z.literal('fr40'),
    frozen: z.boolean(),
    seed: label,
    replicas: z.literal(1),
    arms: z.array(fr40Arm),
    tasks: z
      .array(z.strictObject({ id: identifier, stratum: identifier }))
      .min(1),
    taskFile: inputPath,
    material: inputPath,
    check: argv,
    analysis: z.strictObject({
      alpha: z.number().gt(0).lt(1),
      level: z.number().gt(0).lt(1),
      goPacket: share,
      goRetrieval: share,
      killUpper: share,
      tokenRatio: z.number().positive(),
      stopAfter: z.number().int().min(1),
    }),
    inputs,
  })
  .superRefine((manifest, context) => {
    const ids = manifest.tasks.map((value) => value.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'duplicate task id' });
    const arms = manifest.arms.map((value) => value.id);
    if (arms.length !== 3 || new Set(arms).size !== 3)
      context.addIssue({
        code: 'custom',
        message: 'every task requires all three arms A, B, S',
      });
    const expected = { A: 'none', B: 'packet', S: 'standards' } as const;
    for (const value of manifest.arms)
      if (value.material !== expected[value.id])
        context.addIssue({
          code: 'custom',
          message: `arm ${value.id} material must be ${expected[value.id]}`,
        });
    for (const path of [manifest.taskFile, manifest.material])
      if (!Object.hasOwn(manifest.inputs, path))
        context.addIssue({
          code: 'custom',
          message: `${path} must be listed in inputs`,
        });
  });

type Fr40Manifest = z.infer<typeof fr40Schema>;
export type ExperimentManifest = WozManifest | Fr40Manifest;

/** Narrow to the FR-40 shape. */
export function fr40Manifest(manifest: ExperimentManifest): Fr40Manifest {
  if (!('design' in manifest))
    throw new EvalDataError(`${manifest.id}: not an FR-40 manifest`);
  return manifest;
}

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
  const fr40 =
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, 'design');
  const parsed = (fr40 ? fr40Schema : wozSchema).safeParse(value);
  if (!parsed.success)
    throw new EvalDataError(`manifest.json: ${parsed.error.message}`);
  const manifest = parsed.data;
  if ('design' in manifest) {
    await verifyInputs(root, manifest.inputs, new Set());
    await verifyFr40(root, manifest);
    return manifest;
  }
  const characters = await verifyInputs(
    root,
    manifest.inputs,
    new Set(manifest.tasks.flatMap((value) => [value.packet, value.control])),
  );
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

async function verifyInputs(
  root: string,
  inputs: Record<string, string>,
  materials: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const characters = new Map<string, number>();
  for (const [path, expected] of Object.entries(inputs)) {
    const bytes = await readExperimentFile(root, path);
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw new EvalDataError(`${path}: sha256 mismatch`);
    // Count Unicode code points, including headings, citations and newlines.
    if (materials.has(path))
      characters.set(path, Array.from(utf8(bytes, path)).length);
  }
  return characters;
}

const fr40Material = z.record(
  identifier,
  z.strictObject({ packet: z.string().min(1), standards: z.string().min(1) }),
);

/** Every manifest task has a definition, and arm B and S material, in the hashed inputs. */
async function verifyFr40(root: string, manifest: Fr40Manifest): Promise<void> {
  const json = async (path: string): Promise<unknown> => {
    try {
      return JSON.parse(utf8(await readExperimentFile(root, path), path));
    } catch (error) {
      if (error instanceof EvalDataError) throw error;
      throw new EvalDataError(`${path}: invalid JSON`);
    }
  };
  const definitions = z
    .array(z.looseObject({ id: identifier, template: identifier }))
    .safeParse(await json(manifest.taskFile));
  if (!definitions.success)
    throw new EvalDataError(
      `${manifest.taskFile}: ${definitions.error.message}`,
    );
  const material = fr40Material.safeParse(await json(manifest.material));
  if (!material.success)
    throw new EvalDataError(`${manifest.material}: ${material.error.message}`);
  const strata = new Map(
    definitions.data.map((value) => [value.id, value.template]),
  );
  for (const task of manifest.tasks) {
    if (strata.get(task.id) !== task.stratum)
      throw new EvalDataError(
        `${task.id}: needs a definition with template ${task.stratum} in ${manifest.taskFile}`,
      );
    if (!Object.hasOwn(material.data, task.id))
      throw new EvalDataError(
        `${task.id}: needs packet and standards material in ${manifest.material}`,
      );
  }
}
