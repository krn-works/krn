import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { z } from 'zod';
export class WorkerError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}
export const count = z.number().int().nonnegative().safe();
const processId = count.max(2147483647).refine((value) => value !== 1);
export const modelSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)
  .refine((value) => value.trim() === value);
export const effortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);
const persistedModel = z.union([modelSchema, z.literal('[redacted]')]);
export const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      Buffer.byteLength(value) <= 4096 &&
      [...value].every(
        (character) =>
          character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
      ) &&
      redact(value) === value,
  );
export const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .refine((value) => value.trim() === value && redact(value) === value);
export const timeoutSchema = z
  .number()
  .positive()
  .max(24 * 60 * 60 * 1000);
export const requestSchema = z.object({
  text: z.string().refine((value) => Buffer.byteLength(value) <= 256 * 1024),
  model: persistedModel,
  effort: effortSchema,
  compact: z.enum(['auto', 'always']).default('auto'),
});
export const usageSchema = z.object({
  input: count,
  cached: count,
  output: count,
  uncached_total: count,
});
export const metricsSchema = z.object({
  round: count,
  last: usageSchema,
  cumulative: usageSchema,
  duration_ms: count,
  effort: effortSchema,
  model: persistedModel,
  context_window: count.nullable(),
  compacted: z.boolean(),
});
export const sessionSchema = z.object({
  repo: pathSchema,
  run: pathSchema,
  startCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  model: persistedModel,
  effort: effortSchema,
  timeoutMs: timeoutSchema,
  allows: z.array(pathSchema).max(100),
  roots: z.array(pathSchema).max(2),
  threadId: z.union([identifierSchema, z.literal('')]),
  pid: processId,
  pidStartTime: z.string().regex(/^\d+$/).max(32).nullable(),
  serverPid: processId,
  serverStartTime: z.string().regex(/^\d+$/).max(32).nullable(),
  serverGroup: processId,
  serverExecutable: pathSchema,
  unit: z
    .string()
    .max(256)
    .regex(/^krn-worker-[A-Za-z0-9:_.@-]+\.scope$/)
    .refine((value) => value.trim() === value),
  rounds: count.max(3),
  status: z.enum(['running', 'dead', 'stopped']),
});
export type Session = z.infer<typeof sessionSchema>;
export const resultSchema = z.object({
  rollout_path: z.string().nullable().optional(),
  exit_code: count,
  message: z.string(),
  changed: z.array(z.string()),
  needs_lead_note: z.array(z.string()),
  scope_violations: z.array(z.string()),
});
export const reportSchema = z.strictObject({
  status: z.enum(['done', 'blocked', 'partial']),
  canary: z.string(),
  summary: z.string(),
  changed_paths: z.array(z.string()),
  checks: z.array(
    z.strictObject({
      cmd: z.string(),
      exit_code: z.number().int(),
      note: z.string(),
    }),
  ),
  findings: z.array(
    z.strictObject({
      claim: z.string(),
      evidence: z.string(),
      kind: z.enum(['obs', 'inf']),
    }),
  ),
  unverified: z.array(z.string()),
  blockers: z.array(z.string()),
});
export const outputSchema = z.toJSONSchema(reportSchema);
export const zeroUsage = { input: 0, cached: 0, output: 0, uncached_total: 0 };
export const roundName = (round: number) => String(round).padStart(3, '0');
export function validateRun(repo: string, run: string): string {
  if (!pathSchema.safeParse(repo).success || !pathSchema.safeParse(run).success)
    throw new WorkerError(64, 'invalid worker boundary');
  let realRepo: string;
  try {
    realRepo = realpathSync(repo);
  } catch {
    throw new WorkerError(64, 'invalid worker repository');
  }
  secureDir(repo, false);
  const root = join(realRepo, '.krn');
  const within = (path: string) => {
    const rest = relative(root, path);
    return (
      rest && rest !== '..' && !rest.startsWith('../') && !isAbsolute(rest)
    );
  };
  if (!within(run))
    throw new WorkerError(64, 'worker run must be under repo/.krn/');
  let ancestor = run;
  for (;;) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      ancestor = dirname(ancestor);
    }
  }
  // Inspect the whole existing prefix before any mkdir, including dangling links.
  secureDir(ancestor, false);
  const realRun = resolve(realpathSync(ancestor), relative(ancestor, run));
  if (!within(realRun))
    throw new WorkerError(64, 'worker run must be under repo/.krn/');
  return realRepo;
}

export function secureDir(path: string, create = true): void {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if (create) mkdirSync(cursor, { mode: 0o700 });
    } catch (error) {
      if (!isMissing(error, 'EEXIST')) throw error;
    }
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new WorkerError(65, `unsafe directory: ${cursor}`);
  }
}
export function isMissing(error: unknown, code = 'ENOENT'): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
export function readBytes(path: string, limit: number): Buffer {
  secureDir(dirname(path), false);
  if (lstatSync(path).isSymbolicLink())
    throw new WorkerError(65, `unsafe file: ${path}`);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit)
      throw new WorkerError(65, `invalid or oversized file: ${path}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit - size + 1));
      const length = readSync(fd, buffer, 0, buffer.length, null);
      if (!length) break;
      size += length;
      if (size > limit || size > stat.size)
        throw new WorkerError(65, `file changed or oversized: ${path}`);
      chunks.push(buffer.subarray(0, length));
    }
    const after = fstatSync(fd);
    if (
      size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new WorkerError(65, `file changed during read: ${path}`);
    return Buffer.concat(chunks, size);
  } finally {
    closeSync(fd);
  }
}
export function readText(path: string, limit = 256 * 1024): string {
  try {
    return readBytes(path, limit).toString('utf8');
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError(65, `invalid worker input file: ${path}`);
  }
}
const recordLimit = 2 * 1024 * 1024;
export function readJson<T>(path: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(readText(path, recordLimit)));
  } catch {
    throw new WorkerError(65, `invalid record: ${path}`);
  }
}
export function atomic(path: string, value: unknown): void {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > recordLimit)
    throw new WorkerError(65, 'worker record exceeds 2 MB');
  secureDir(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    if (!isMissing(error, 'EEXIST')) rmSync(temporary, { force: true });
    throw error;
  }
}
export function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return false;
  }
}
export function lock(path: string): () => void {
  try {
    const fd = openSync(path, 'wx', 0o600);
    closeSync(fd);
  } catch (error) {
    if (isMissing(error, 'EEXIST'))
      throw new WorkerError(75, `worker locked: ${path}`);
    throw error;
  }
  return () => rmSync(path, { force: true });
}
export function failure(error: unknown): WorkerError {
  return error instanceof WorkerError
    ? error
    : new WorkerError(70, 'worker internal failure');
}
export function redact(text: string): string {
  return text
    .replace(
      /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
      '[redacted]',
    )
    .replace(/AKIA[0-9A-Z]{16}/g, '[redacted]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(
      /\b((?=[A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH))[A-Za-z_][A-Za-z0-9_-]*["']?[ \t]*[=:][ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s",}]+)/gi,
      '$1[redacted]',
    );
}
