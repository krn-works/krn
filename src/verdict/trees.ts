// Verdict worktree lifecycle: disposable tree creation, owner records, quarantine, orphan sweep, cleanup.
import { spawnSync } from 'node:child_process';
// biome-ignore format: These filesystem primitives form the sandbox's owned I/O surface.
import { closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { git, run } from './process.ts';

async function registeredWorktrees(root: string): Promise<string[]> {
  const result = await run(
    'git',
    ['-C', root, 'worktree', 'list', '--porcelain'],
    root,
  );
  if (result.status !== 0)
    throw new Error(result.stderr.toString() || 'cannot list worktrees');
  return result.stdout
    .toString()
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)));
}

export async function pruneExactWorktree(
  root: string,
  copy: string,
): Promise<void> {
  const exactPath = resolve(copy);
  // biome-ignore format: Keep removal bound to the resolved disposable path.
  const removed = await run('git', ['-C', root, 'worktree', 'remove', '--force', exactPath], root);

  // `git worktree prune` has no path argument. Remove only the administrative
  // record whose gitdir points at this disposable worktree if remove left it.
  if ((await registeredWorktrees(root)).includes(exactPath)) {
    // biome-ignore format: Resolve the exact common git directory for this worktree.
    const commonDir = resolve(root, await git(root, ['rev-parse', '--git-common-dir']));
    const adminRoot = join(commonDir, 'worktrees');
    if (existsSync(adminRoot)) {
      for (const name of readdirSync(adminRoot)) {
        const admin = join(adminRoot, name);
        const pointer = join(admin, 'gitdir');
        if (!existsSync(pointer)) continue;
        if (
          resolve(readFileSync(pointer, 'utf8').trim()) !==
          join(exactPath, '.git')
        )
          continue;
        rmSync(admin, { recursive: true, force: true });
        break;
      }
    }
  }
  if (
    (await registeredWorktrees(root)).includes(exactPath) ||
    removed.status !== 0
  )
    throw new Error(
      removed.stderr.toString() ||
        `could not prune verdict worktree ${exactPath}`,
    );
  rmSync(exactPath, { recursive: true, force: true });
  removeVerdictTreeOwner(exactPath);
}

const verdictTreeOwnerSchema = z.object({
  pid: z.number().int().positive(),
  start: z.string().regex(/^\d+$/u),
  quarantined: z.boolean().optional(),
});

function verdictTreeOwnerPath(copy: string): string {
  return join(dirname(copy), '.verdict-owners', `${basename(copy)}.json`);
}

function verdictTreeOwners(directory: string, create = false) {
  const owners = join(directory, '.verdict-owners');
  if (create) mkdirSync(owners, { recursive: true, mode: 0o700 });
  const info = lstatSync(owners, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    realpathSync(owners) !== join(realpathSync(directory), '.verdict-owners')
  )
    throw new Error(`unsafe verdict owner directory: ${owners}`);
  return owners;
}

function reportVerdictOwnerError(error: unknown): void {
  process.stderr.write(
    `verdict owner record failed: ${String(error).replace(/\s+/gu, ' ')}\n`,
  );
}

function readVerdictTreeOwner(record: string) {
  const fd = openSync(record, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return verdictTreeOwnerSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } finally {
    closeSync(fd);
  }
}

function writeVerdictTreeOwner(
  record: string,
  owner: z.infer<typeof verdictTreeOwnerSchema>,
): void {
  const fd = openSync(
    record,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(owner));
  } finally {
    closeSync(fd);
  }
}

export function removeVerdictTreeOwner(copy: string): void {
  try {
    if (!verdictTreeOwners(dirname(copy))) return;
  } catch (error) {
    reportVerdictOwnerError(error);
    return;
  }
  const record = verdictTreeOwnerPath(copy);
  rmSync(record, { force: true });
  try {
    rmdirSync(dirname(record));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(error.code))
    )
      throw error;
  }
}

export function quarantineVerdictTree(copy: string): void {
  try {
    verdictTreeOwners(dirname(copy));
  } catch (error) {
    reportVerdictOwnerError(error);
    return;
  }
  const record = verdictTreeOwnerPath(copy);
  // The empty temporary file marks quarantine intent before any read or write can fail;
  // the sweep honours it until the tree is gone. Rename keeps the record atomic.
  const temporary = verdictTreeOwnerTemporary(record);
  rmSync(temporary, { force: true });
  closeSync(
    openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    ),
  );
  const owner = readVerdictTreeOwner(record);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
  );
  try {
    writeFileSync(fd, JSON.stringify({ ...owner, quarantined: true }));
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, record);
}

function quarantineIntended(owners: string | undefined, copy: string): boolean {
  if (!owners) return false;
  const prefix = `.${basename(copy)}.json.`;
  return readdirSync(owners).some(
    (name) => name.startsWith(prefix) && name.endsWith('.tmp'),
  );
}

// Quarantine every copy, newest first (the copy whose teardown failed is last allocated);
// one failure must never leave the remaining copies unprotected.
export function quarantineVerdictTrees(copies: readonly string[]): void {
  const errors: unknown[] = [];
  for (const copy of [...copies].reverse()) {
    try {
      quarantineVerdictTree(copy);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    process.stderr.write(
      `verdict quarantine failed: ${errors.map(String).join('; ').replace(/\s+/gu, ' ')}\n`,
    );
    process.exitCode = 1;
  }
}

function verdictTreeOwnerTemporary(record: string): string {
  return join(dirname(record), `.${basename(record)}.${process.pid}.tmp`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return false;
    return true;
  }
}

function processStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // comm (field 2) can contain spaces and parentheses; fields after it start at 3.
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/u)[19];
  if (!start || !/^\d+$/u.test(start))
    throw new Error(`invalid process start for ${pid}`);
  return start;
}

function verdictTreeOwnerAlive(pid: number, start: string): boolean {
  try {
    return processStart(pid) === start;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ESRCH')
    )
      return false;
    throw error;
  }
}

function liveCheckScopes(): boolean {
  const result = spawnSync(
    'systemctl',
    ['--user', 'list-units', 'krn-check-*', '--all', '--plain', '--no-legend'],
    { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' },
  );
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(result.stderr || 'scope probe failed');
  return result.stdout.split(/\r?\n/u).some((line) => {
    const [unit, , state] = line.trim().split(/\s+/u);
    return (
      unit?.startsWith('krn-check-') &&
      unit.endsWith('.scope') &&
      state !== 'inactive'
    );
  });
}

export async function sweepOrphanedVerdictTrees(
  root: string,
  directory: string,
  options: {
    readonly scopeProbe?: () => boolean | Promise<boolean>;
    readonly now?: () => number;
    readonly isOwnerAlive?: (pid: number, start: string) => boolean;
  } = {},
): Promise<void> {
  const errors: unknown[] = [];
  let scopesLive: boolean | undefined;
  // A failed probe counts as live: a quarantined tree is kept rather than risked.
  const scopesMayBeLive = async () => {
    if (scopesLive === undefined) {
      try {
        scopesLive = await (options.scopeProbe ?? liveCheckScopes)();
      } catch (error) {
        errors.push(error);
        scopesLive = true;
      }
    }
    return scopesLive;
  };
  try {
    const owners = verdictTreeOwners(directory);
    const now = (options.now ?? Date.now)();
    for (const name of readdirSync(directory)) {
      if (!name.startsWith('verdict-')) continue;
      verdictTreeOwners(directory);
      try {
        const copy = join(directory, name);
        const info = lstatSync(copy);
        const record = verdictTreeOwnerPath(copy);
        let owner: z.infer<typeof verdictTreeOwnerSchema> | undefined;
        if (owners) {
          try {
            owner = readVerdictTreeOwner(record);
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !('code' in error) ||
              error.code !== 'ENOENT'
            )
              errors.push(error);
          }
        }
        if (owner) {
          if (
            (options.isOwnerAlive ?? verdictTreeOwnerAlive)(
              owner.pid,
              owner.start,
            )
          )
            continue;
          if (
            (owner.quarantined || quarantineIntended(owners, copy)) &&
            (await scopesMayBeLive())
          )
            continue;
        } else if (now - info.mtimeMs <= 24 * 60 * 60 * 1000) continue;
        else if (quarantineIntended(owners, copy) && (await scopesMayBeLive()))
          continue;
        verdictTreeOwners(directory);
        if (!info.isDirectory()) {
          unlinkSync(copy);
          removeVerdictTreeOwner(copy);
          continue;
        }
        const gitPath = join(copy, '.git');
        if (existsSync(gitPath) && lstatSync(gitPath).isFile()) {
          await pruneExactWorktree(root, copy);
        } else {
          rmSync(copy, { recursive: true, force: true });
          removeVerdictTreeOwner(copy);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (owners && verdictTreeOwners(directory)) {
      for (const record of readdirSync(owners)) {
        const temporary = /^\.(verdict-.+)\.json\.(\d+)\.tmp$/u.exec(record);
        if (
          temporary?.[1] &&
          !processExists(Number(temporary[2])) &&
          !lstatSync(join(directory, temporary[1]), { throwIfNoEntry: false })
        )
          rmSync(join(owners, record), { force: true });
        if (!record.startsWith('verdict-') || !record.endsWith('.json'))
          continue;
        const copy = join(directory, record.slice(0, -'.json'.length));
        if (!lstatSync(copy, { throwIfNoEntry: false }))
          removeVerdictTreeOwner(copy);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    process.stderr.write(
      `verdict tree sweep failed: ${errors.map(String).join('; ').replace(/\s+/gu, ' ')}\n`,
    );
}

const verdictTreeSweeps = new Map<string, Promise<void>>();

// biome-ignore format: Directory creation is the first tracked cleanup step after the shared sweep.
export async function createWorktreeDirectory(directory: string, root: string): Promise<string> {
  try {
    verdictTreeOwners(directory);
  } catch (error) {
    reportVerdictOwnerError(error);
    return mkdtempSync(join(directory, 'verdict-'));
  }
  const key = resolve(directory);
  let sweep = verdictTreeSweeps.get(key);
  if (!sweep) {
    sweep = sweepOrphanedVerdictTrees(root, directory);
    verdictTreeSweeps.set(key, sweep);
  }
  await sweep;
  const copy = mkdtempSync(join(directory, 'verdict-'));
  try {
    verdictTreeOwners(directory, true);
  } catch (error) {
    reportVerdictOwnerError(error);
    return copy;
  }
  try {
    const record = verdictTreeOwnerPath(copy);
    writeVerdictTreeOwner(record, {
      pid: process.pid,
      start: processStart(process.pid),
    });
    return copy;
  } catch (error) {
    rmSync(copy, { recursive: true, force: true });
    removeVerdictTreeOwner(copy);
    throw error;
  }
}

// biome-ignore format: Attach the allocated directory to the exact checked SHA.
export async function addWorktree(root: string, copy: string, sha: string): Promise<void> { await git(root, ['worktree', 'add', '--detach', copy, sha]); }

// biome-ignore format: Keep the cleanup boundary signature compact.
export async function cleanupWorktrees(root: string, copies: readonly string[]): Promise<void> {
  const errors: unknown[] = [];
  for (const copy of copies) {
    try {
      await pruneExactWorktree(root, copy);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    process.stderr.write(
      `verdict worktree cleanup failed: ${errors.map(String).join('; ')}\n`,
    );
    process.exitCode = 1;
  }
}
