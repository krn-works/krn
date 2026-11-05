import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { stages } from './stages.ts';

export const journalSchema = z.object({
  task: z.string(),
  name: z.string(),
  branch: z.string(),
  worktree: z.string(),
  base: z.string(),
  brief: z.string(),
  message: z.string(),
  repo: z.string(),
  model: z.string(),
  effort: z.string(),
  pr: z.number().int().positive().safe().nullable(),
  stage: z.enum(stages),
  completed: z.boolean(),
  reviewAttempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  reviewRecord: z.string().nullable(),
  argv: z.array(z.string()).max(64),
  exitCode: z.number().int().min(0),
  cause: z.string(),
  worktreeCreated: z.boolean().optional(),
  implementationCommitted: z.boolean().optional(),
  taskClosed: z.boolean().optional(),
  closeCommitted: z.boolean().optional(),
  pushed: z.boolean().optional(),
  workerOpen: z.boolean().optional(),
  reviewPending: z.boolean().optional(),
  reviewHead: z
    .string()
    .regex(/^[a-f\d]{40,64}$/u)
    .nullable()
    .optional(),
  gateHead: z.string().nullable().optional(),
  landing: z.object({ log: z.string(), exit: z.string() }).optional(),
  reviewOverride: z.boolean().optional(),
  reviewFailed: z.boolean().optional(),
});
export type Journal = z.infer<typeof journalSchema>;

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function journalPath(root: string, task: string): Promise<string> {
  let directory = root;
  for (const part of ['.krn', 'runs', 'slice', task]) {
    directory = join(directory, part);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`unsafe journal directory: ${directory}`);
    } catch (error) {
      if (!missing(error)) throw error;
      await mkdir(directory);
    }
  }
  return join(directory, 'journal.json');
}

async function checkFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error(`unsafe journal: ${path}`);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
export async function readJournal(path: string): Promise<Journal | undefined> {
  if (!(await checkFile(path))) return undefined;
  try {
    return journalSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    throw new Error(`corrupt journal: ${path}`);
  }
}
export async function writeJournal(
  path: string,
  state: Journal,
): Promise<void> {
  let directory = dirname(path);
  for (let depth = 0; depth < 4; depth++) {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`unsafe journal directory: ${directory}`);
    directory = dirname(directory);
  }
  await checkFile(path);
  const temporary = join(dirname(path), `.journal-${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(journalSchema.parse(state), null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
