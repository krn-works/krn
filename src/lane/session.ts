// Which lane a Stop belongs to, read from the lane manifest (ADR 0029 decision 1, migration step 4):
// the manifest names the lane's branch, worktree and task, so Stop no longer infers them from transcripts
// and raw claim files. A session with no manifest is a lane started before manifests existed; `legacy.ts`
// answers for it with today's reads.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { ContractError, resolveContract } from '../repo/contract.ts';
import { laneMergeVerdict } from '../repo/merge-verdict.ts';
import { shipRecordDir } from '../repo/ship-record.ts';
import {
  legacyClaims,
  legacyEditedWorktrees,
  legacyLaneWorktree,
  legacyTaskIds,
} from './legacy.ts';
import { type LaneManifest, listManifests } from './manifest.ts';

const git = (root: string, args: string[]) =>
  spawnSync('git', args, { cwd: root, encoding: 'utf8' });

/** The base branch the contract names; a tree with no readable contract is judged on `main`. */
function baseOf(root: string): string {
  try {
    return resolveContract(root).contract?.base ?? 'main';
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return 'main';
  }
}

export function onBase(root: string, sha: string): boolean {
  const named = baseOf(root);
  const merged = () =>
    [`origin/${named}`, named].some(
      (ref) =>
        git(root, ['merge-base', '--is-ancestor', sha, ref]).status === 0,
    );
  if (merged()) return true;
  const fetched = spawnSync('git', ['fetch', '-q', 'origin', named], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return fetched.status === 0 && merged();
}

const laneMarker = `${sep}.krn${sep}worktrees${sep}`;

/**
 * The lane worktree a path lies in, as `<owner>/.krn/worktrees/<name>`. An existing path belongs to its nearest
 * enclosing checkout only: a repository created under another lane's `.krn/tmp` (a test temp dir) is its own main.
 * A path that is gone is a lane tree only when it is exactly `<owner>/.krn/worktrees/<name>`.
 */
export function laneTreeOf(
  path: string,
): { owner: string; name: string } | undefined {
  let top = path;
  if (existsSync(path)) {
    while (!existsSync(join(top, '.git'))) {
      const up = dirname(top);
      if (up === top) return undefined;
      top = up;
    }
    if (!statSync(join(top, '.git')).isFile()) return undefined;
  }
  const at = top.lastIndexOf(laneMarker);
  if (at < 0) return undefined;
  const rest = top.slice(at + laneMarker.length).split(sep);
  const name = rest[0];
  if (!existsSync(path) && rest.length !== 1) return undefined;
  return name ? { owner: top.slice(0, at), name } : undefined;
}

/** The main checkout of a path: the repository's common git dir, else the owner of a removed lane worktree. */
function mainOf(root: string): string | undefined {
  if (existsSync(root)) {
    const common = git(root, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    if (common.status === 0) return dirname(common.stdout);
  }
  return laneTreeOf(root)?.owner;
}

/**
 * The manifests of the lane a session belongs to, retired ones included (a shipped lane's worktree is gone
 * and its manifest retired, but Stop still judges its ship): the manifest `KRN_LANE_ID` names, the ones that
 * hold the subagent's `agent_id`, and those of the session's `KRN_TASK`.
 */
export function sessionManifests(
  main: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
): LaneManifest[] {
  const fields = payload as { agent_type?: unknown; agent_id?: unknown } | null;
  const agent =
    fields?.agent_type === 'krn-lane' && typeof fields.agent_id === 'string'
      ? fields.agent_id
      : undefined;
  return listManifests(main).filter(
    (m) =>
      m.laneId === env.KRN_LANE_ID ||
      (agent !== undefined && m.agents.includes(agent)) ||
      (env.KRN_TASK !== undefined && m.task === env.KRN_TASK),
  );
}

/** What the repository recorded about a lane a session started: its manifest, or the ship record of a merged one. */
export type LaneRecord = { branch: string; worktree?: string; sha?: string };

function shipRecordsOf(main: string, ids: readonly string[]): LaneRecord[] {
  const dir = join(main, shipRecordDir);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    /* No ship records. */
  }
  const records: LaneRecord[] = [];
  for (const name of names) {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        branch?: unknown;
        task?: unknown;
        sha?: unknown;
      };
      if (
        typeof record.branch === 'string' &&
        record.branch !== '' &&
        typeof record.task === 'string' &&
        ids.includes(record.task)
      )
        records.push({
          branch: record.branch,
          ...(typeof record.sha === 'string' ? { sha: record.sha } : {}),
        });
    } catch {
      /* An unreadable record proves nothing. */
    }
  }
  return records;
}

/** The task a session works, for exposure logs: its manifest's, else KRN_TASK, else the first the legacy reads find. */
export function sessionTask(
  root: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
): string | undefined {
  const main = mainOf(root);
  const manifest =
    main === undefined ? [] : sessionManifests(main, env, payload);
  return (
    manifest.find((m) => m.task !== undefined)?.task ??
    (manifest.length > 0 ? env.KRN_TASK : legacyTaskIds(env, payload)[0])
  );
}

/**
 * The one resolution of "which branch and worktree is this session's lane": the manifest of the session
 * (a lane with none is read the legacy way), plus the ship records of its task once it merged.
 */
export function laneRecords(
  root: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
): LaneRecord[] {
  const main = mainOf(root);
  if (main === undefined) return [];
  const manifests = sessionManifests(main, env, payload);
  if (manifests.length === 0) {
    const ids = legacyTaskIds(env, payload);
    return [...legacyClaims(main, ids), ...shipRecordsOf(main, ids)];
  }
  const ids = [
    ...new Set(
      [...manifests.map((m) => m.task), env.KRN_TASK].filter(
        (id): id is string => id !== undefined,
      ),
    ),
  ];
  const own: LaneRecord[] = manifests.flatMap((m) =>
    m.branch === undefined
      ? []
      : [
          {
            branch: m.branch,
            ...(m.phase.kind !== 'retired' && m.worktree !== undefined
              ? { worktree: m.worktree }
              : {}),
            ...(m.phase.kind === 'merged' ? { sha: m.phase.sha } : {}),
          },
        ],
  );
  return [...own, ...shipRecordsOf(main, ids)];
}

/** The branches of the lanes a session started, claimed or shipped. */
export function claimedBranches(
  root: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
): string[] {
  return [...new Set(laneRecords(root, env, payload).map((r) => r.branch))];
}

/** The worktrees a lane subagent edited, read from its manifest; a lane with none is read from its transcript. */
export function editedLaneWorktrees(
  root: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
): string[] {
  const main = mainOf(root);
  if (main === undefined) return [];
  const manifests = sessionManifests(main, env, payload);
  if (manifests.length === 0) return legacyEditedWorktrees(main, payload);
  return manifests.flatMap((m) =>
    m.phase.kind !== 'retired' &&
    m.worktree !== undefined &&
    existsSync(m.worktree)
      ? [m.worktree]
      : [],
  );
}

/**
 * The worktree a krn-lane subagent works in. It shares the lead's session cwd, so the payload cwd may sit in
 * the lead's worktree or the main checkout: the live manifest that holds its `agent_id` names the worktree.
 * A subagent no manifest holds is a legacy lane. Returns the payload cwd when neither finds one.
 */
export function laneWorktree(
  cwd: string,
  payload: unknown,
  projectDir?: string,
): string {
  for (const dir of [cwd, projectDir]) {
    if (dir === undefined || !existsSync(dir)) continue;
    const main = mainOf(dir);
    if (main === undefined) continue;
    const bound = sessionManifests(main, {}, payload).find(
      (m) =>
        m.phase.kind !== 'retired' &&
        m.worktree !== undefined &&
        existsSync(m.worktree),
    );
    if (bound?.worktree !== undefined) return bound.worktree;
    if (sessionManifests(main, {}, payload).length > 0) continue;
    const legacy = legacyLaneWorktree(main, payload);
    if (legacy !== undefined) return legacy;
  }
  return cwd;
}

/**
 * `krn pr ship` removes a merged lane's worktree, so a lane may stop with its cwd gone (t-vs35jd7, #1137:
 * Stop crashed spawning tests there). A missing `<main>/.krn/worktrees/<name>` is judged at `<main>`.
 */
export function ownerCheckout(root: string): string {
  if (existsSync(root)) return root;
  const owner = laneTreeOf(root)?.owner;
  return owner !== undefined && existsSync(owner) ? owner : root;
}

/**
 * A shell that returned to the main checkout (the cwd resets after each Bash call) is judged at the worktree
 * of the lane the session holds; a session already inside a lane worktree keeps its own.
 */
export function claimedWorktree(
  start: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
): string {
  if (laneTreeOf(start) || !existsSync(start)) return start;
  const tree = laneRecords(start, env, payload).find(
    (record) => record.worktree !== undefined && existsSync(record.worktree),
  )?.worktree;
  return tree ?? start;
}

/**
 * Where `krn pr ship` recorded a merged ship for this session's lane, whose branch and worktree it then
 * removed. The last message need not repeat the verdict: lanes ended "the branch was deleted after merge"
 * and were refused. The record counts when its merge commit is on the base and the hook runs in a removed
 * worktree, the main checkout, or a kept lane worktree whose branch and tip are the recorded ones. It is
 * found by the session's lane (its manifest, else its legacy claim) or the session's KRN_TASK.
 */
export function recordedShip(
  root: string,
  env: NodeJS.ProcessEnv,
  branch = '',
  payload: unknown = undefined,
): boolean {
  const named = baseOf(root);
  const current = branch.trim();
  // On a lane branch the record counts only for a kept worktree whose tip is still the shipped head:
  // a lane agent's ship keeps worktree and branch for the next lane start to prune (t-hswt15n).
  const onLane = current !== '' && current !== named;
  const tree = laneTreeOf(root);
  const main = mainOf(root);
  if (main === undefined) return false;
  const lane = tree?.name ?? '';
  // A lane worktree still on disk counts only while its tip is the shipped head: later work there is unshipped.
  const kept = lane !== '' && existsSync(join(root, '.git'));
  const tip =
    kept || onLane ? git(root, ['rev-parse', 'HEAD']).stdout.trim() : '';
  const head = kept || onLane ? tip : undefined;
  const claimed = claimedBranches(main, env, payload);
  // A manifest the lane reached `merged` in is the ship's own verdict, no record file needed.
  for (const m of sessionManifests(main, env, payload)) {
    if (
      m.phase.kind === 'merged' &&
      (!onLane || m.branch === current) &&
      laneMergeVerdict({
        record: { sha: m.phase.sha, head: m.phase.head },
        head,
        merged: (sha) => onBase(main, sha),
      }) === 'merged'
    )
      return true;
  }
  const dir = join(main, shipRecordDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        branch?: unknown;
        task?: unknown;
        sha?: unknown;
        head?: unknown;
      };
      if (onLane && record.branch !== current) continue;
      const ours =
        (lane !== '' && record.branch === lane) ||
        (typeof record.branch === 'string' &&
          claimed.includes(record.branch)) ||
        (env.KRN_TASK !== undefined && record.task === env.KRN_TASK);
      if (
        ours &&
        typeof record.sha === 'string' &&
        laneMergeVerdict({
          record: {
            sha: record.sha,
            ...(typeof record.head === 'string' ? { head: record.head } : {}),
          },
          head,
          merged: (sha) => onBase(main, sha),
        }) === 'merged'
      )
        return true;
    } catch {
      /* An unreadable record proves nothing. */
    }
  }
  return false;
}
