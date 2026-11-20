// The one writer of lane manifests (ADR 0029 decision 1): `.krn/runs/lanes/<laneId>.json` in the main checkout.
// Every write validates its transition against the table below before it touches the file, and no caller
// writes the file itself (STORES in scripts/boundaries.ts).
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

/** Where manifests live, relative to the main checkout; the directory also holds lead files, which readers skip. */
export const laneManifestDir = '.krn/runs/lanes';
/** A retired manifest older than this is deleted by `krn prune`. */
export const RETIRED_KEEP_MS = 7 * 24 * 3_600_000;

const sha = z.string().regex(/^[0-9a-f]{7,40}$/u);
const pr = z.number().int().positive();

export const lanePhase = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reserved') }).strict(),
  z.object({ kind: z.literal('started') }).strict(),
  z
    .object({
      kind: z.literal('shipping'),
      pid: z.number().int().positive(),
      head: sha,
      pr: pr.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('shipped'), pr, head: sha }).strict(),
  z.object({ kind: z.literal('parked'), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('merged'), sha, head: sha }).strict(),
  z
    .object({
      kind: z.literal('retired'),
      at: z.iso.datetime(),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type LanePhase = z.infer<typeof lanePhase>;

const laneId = z.string().regex(/^[a-z0-9][a-z0-9._-]*-[0-9a-z]{6}$/u);

export const laneManifest = z
  .object({
    laneId,
    slug: z.string().min(1),
    branch: z.string().min(1).optional(),
    worktree: z.string().min(1).optional(),
    base: z.string().min(1),
    task: z.string().optional(),
    targets: z.array(z.string()),
    actor: z.string().min(1),
    createdAt: z.iso.datetime(),
    agents: z.array(z.string()),
    phase: lanePhase,
  })
  .strict();
export type LaneManifest = z.infer<typeof laneManifest>;

/** A refused transition or an unreadable manifest: an internal error, exit 70. */
export class LaneManifestError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 70) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** `<slug>-<6 random base36>`: a reused slug, branch or task always gets a new lane. */
export function newLaneId(slug: string): string {
  const digits = [...randomBytes(6)].map((b) => (b % 36).toString(36));
  return `${slug}-${digits.join('')}`;
}

/** The ADR 0029 transition table as one exhaustive switch; `undefined` is a lane with no manifest yet. */
export function allowedTransition(
  from: LanePhase | undefined,
  to: LanePhase,
): boolean {
  if (from === undefined)
    return to.kind === 'reserved' || to.kind === 'started';
  switch (from.kind) {
    case 'reserved':
      return to.kind === 'started' || to.kind === 'retired';
    case 'started':
      return ['shipping', 'parked', 'retired'].includes(to.kind);
    case 'shipping':
      // The one self-edge: ship records the PR it opened, under the same live pid.
      if (to.kind === 'shipping')
        return to.pr !== undefined && to.pid === from.pid;
      return ['merged', 'shipped', 'started', 'retired'].includes(to.kind);
    case 'shipped':
      return ['shipping', 'started', 'merged', 'retired'].includes(to.kind);
    case 'parked':
      return to.kind === 'started' || to.kind === 'retired';
    case 'merged':
      return to.kind === 'retired';
    case 'retired':
      return false;
    default: {
      const unreachable: never = from;
      return unreachable;
    }
  }
}

function manifestPath(main: string, id: string): string {
  return join(main, laneManifestDir, `${id}.json`);
}

function parse(text: string): LaneManifest | undefined {
  try {
    const parsed = laneManifest.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readBytes(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

/** The manifest of `id`, or undefined when there is none or it does not parse. */
export function readManifest(
  main: string,
  id: string,
): LaneManifest | undefined {
  const bytes = readBytes(manifestPath(main, id));
  return bytes === undefined ? undefined : parse(bytes.toString('utf8'));
}

/** Every manifest that parses; directories, lead files and torn JSON in the same directory are skipped. */
export function listManifests(main: string): LaneManifest[] {
  let names: string[];
  try {
    names = readdirSync(join(main, laneManifestDir));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readManifest(main, name.slice(0, -'.json'.length)))
    .filter((m): m is LaneManifest => m?.laneId !== undefined);
}

/** The live (not retired) manifest whose worktree is exactly `worktree`. */
export function liveManifestOfWorktree(
  main: string,
  worktree: string,
): LaneManifest | undefined {
  return listManifests(main).find(
    (m) => m.worktree === worktree && m.phase.kind !== 'retired',
  );
}

function stage(path: string, manifest: LaneManifest): string {
  // A short name beside the manifest: a long slug must not push it past the file name limit.
  const temporary = join(
    dirname(path),
    `.${process.pid}-${randomBytes(4).toString('hex')}.tmp`,
  );
  const fd = openSync(temporary, 'wx', 0o644);
  try {
    writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temporary;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

/**
 * Creates the manifest of a new lane in phase `phase`. The file appears by an exclusive hard link, as a claim
 * does (`src/task/claims.ts`), so a second writer of the same id is refused rather than overwritten.
 */
export function createManifest(
  main: string,
  fields: Omit<LaneManifest, 'phase'>,
  phase: LanePhase,
): LaneManifest {
  if (!allowedTransition(undefined, phase))
    throw new LaneManifestError(
      `lane manifest: a new lane cannot start in phase ${phase.kind}`,
    );
  const manifest = laneManifest.parse({ ...fields, phase });
  if (
    manifest.worktree !== undefined &&
    liveManifestOfWorktree(main, manifest.worktree) !== undefined
  )
    throw new LaneManifestError(
      `lane manifest: ${manifest.worktree} already has a live lane; retire it first`,
    );
  const path = manifestPath(main, manifest.laneId);
  mkdirSync(join(main, laneManifestDir), { recursive: true });
  const temporary = stage(path, manifest);
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (errorCode(error) === 'EEXIST')
      throw new LaneManifestError(
        `lane manifest: ${manifest.laneId} already exists`,
        75,
      );
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
  return manifest;
}

/**
 * Moves lane `id` to phase `to`. The edge is validated against the table first; a refused edge writes nothing.
 * The writer that takes the marker named by the digest of the bytes it read is the only one that may replace
 * them (the expired-claim scheme of `src/task/claims.ts`); a writer that lost the race is refused with exit 75.
 */
export function transition(
  main: string,
  id: string,
  to: LanePhase,
): LaneManifest {
  const path = manifestPath(main, id);
  const seen = readBytes(path);
  const current = seen === undefined ? undefined : parse(seen.toString('utf8'));
  if (seen === undefined || current === undefined)
    throw new LaneManifestError(
      `lane manifest: no readable manifest for ${id}`,
    );
  const next = laneManifest.parse({ ...current, phase: lanePhase.parse(to) });
  if (!allowedTransition(current.phase, next.phase))
    throw new LaneManifestError(
      `lane manifest: ${id} cannot move from ${current.phase.kind} to ${next.phase.kind}`,
    );
  const digest = createHash('sha256').update(seen).digest('hex');
  const marker = join(dirname(path), `.${digest.slice(0, 32)}.lock`);
  try {
    writeFileSync(marker, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (errorCode(error) === 'EEXIST')
      throw new LaneManifestError(`lane manifest: ${id} is being written`, 75);
    throw error;
  }
  try {
    const again = readBytes(path);
    if (again === undefined || !again.equals(seen))
      throw new LaneManifestError(
        `lane manifest: ${id} changed while it was being written`,
        75,
      );
    renameSync(stage(path, next), path);
  } finally {
    rmSync(marker, { force: true });
  }
  return next;
}

/**
 * Retires the live manifest of a worktree path that no longer exists (a lane dropped before drop wrote
 * `retired`), so a new lane may start at the same path; a path still on disk keeps its lane.
 */
export function retireGoneLane(main: string, worktree: string): void {
  if (existsSync(worktree)) return;
  // Manifests hold the real path; the main checkout may be reached through a symlink.
  let real = worktree;
  try {
    real = join(realpathSync(dirname(worktree)), basename(worktree));
  } catch {
    /* No worktrees directory yet: no lane ever started there. */
  }
  const stale = liveManifestOfWorktree(main, real);
  if (stale !== undefined)
    transition(main, stale.laneId, {
      kind: 'retired',
      at: new Date().toISOString(),
      reason: 'its worktree is gone; a new lane starts at the same path',
    });
}

/** Retired manifests whose retirement is older than RETIRED_KEEP_MS: what `krn prune` deletes; live ones never. */
export function expiredManifests(main: string, now = Date.now()): string[] {
  return listManifests(main)
    .filter(
      (m) =>
        m.phase.kind === 'retired' &&
        now - Date.parse(m.phase.at) > RETIRED_KEEP_MS,
    )
    .map((m) => manifestPath(main, m.laneId));
}
