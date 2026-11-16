// The declared layout of the ignored .krn/ state directory: every allowed
// top-level entry and every runs/ category with its owner, purpose and
// retention. `krn state check` reports what falls outside it, `krn state tidy`
// moves strays into .krn/tmp/stray/ and deletes what is past retention, and
// both regenerate .krn/INDEX.md from this table. An entry the schema does not
// name is a stray; an entry whose retention is `keep` is never deleted.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type Retention = 'keep' | { days: number };

export interface LayoutEntry {
  name: string;
  kind: 'dir' | 'file';
  owner: string;
  purpose: string;
  /** When children (a dir's entries) are deleted; the entry itself is never deleted. */
  retention: Retention;
}

export interface RunCategory {
  name: string;
  /** Run owners (children of runs/) this category covers: exact names or patterns. */
  match: RegExp;
  owner: string;
  purpose: string;
  retention: Retention;
}

const KEEP: Retention = 'keep';

export const TOP_LEVEL: readonly LayoutEntry[] = [
  entry(
    'INDEX.md',
    'file',
    'krn state tidy',
    'generated listing of this directory',
    KEEP,
  ),
  entry(
    'adopted.json',
    'file',
    'krn adopt',
    'record of what adoption installed',
    KEEP,
  ),
  entry(
    'conventions.json',
    'file',
    'krn adopt',
    'repository convention overrides',
    KEEP,
  ),
  entry('archive', 'dir', 'review', 'archived review records and series', KEEP),
  entry('brain', 'dir', 'brain', 'task and standards memory', KEEP),
  entry('cache', 'dir', 'krn', 'rebuildable caches', KEEP),
  entry('locks', 'dir', 'krn', 'lock files held by running commands', KEEP),
  entry(
    'operator',
    'dir',
    'operator',
    'operator-supplied notes and grants',
    KEEP,
  ),
  entry('plan', 'dir', 'lead', 'plan files', KEEP),
  entry(
    'product-release',
    'dir',
    'krn product-release',
    'release checkout state, never deleted',
    KEEP,
  ),
  entry(
    'product-release.lock',
    'file',
    'krn product-release',
    'release lock, never deleted',
    KEEP,
  ),
  entry(
    'runs',
    'dir',
    'lead and lanes',
    'run data by owner, see RUN_CATEGORIES',
    KEEP,
  ),
  entry(
    'sources',
    'dir',
    'research',
    'third-party clones read by research agents, never deleted by tidy',
    KEEP,
  ),
  entry(
    'successors',
    'dir',
    'successor',
    'successor pane and launch ledgers',
    KEEP,
  ),
  entry(
    'task-claims',
    'dir',
    'krn task',
    'live task claims, never deleted by tidy',
    KEEP,
  ),
  entry(
    'tmp',
    'dir',
    'any agent',
    'scratch files and moved strays; children expire',
    { days: 14 },
  ),
  entry(
    'worktrees',
    'dir',
    'krn lane',
    'lane worktrees, never deleted by tidy',
    KEEP,
  ),
];

export const RUN_CATEGORIES: readonly RunCategory[] = [
  category(
    'delivery-loop',
    /^delivery-loop$/,
    'lead',
    'capsules and handoffs',
    KEEP,
  ),
  category(
    'overnight',
    /^overnight$/,
    'lead',
    'overnight run records and handoffs',
    KEEP,
  ),
  category('lead', /^lead$/, 'lead', 'lead session records', KEEP),
  category(
    'lanes',
    /^(lanes(-\d.*)?|lane-briefs|lane-run-e2e|task-record-lanes|worker|ship|ship-prepush|launcher-running-work|relay-no-merge|sandbox-run)$/,
    'lane',
    'lane briefs, prompts and ship logs',
    { days: 60 },
  ),
  category(
    'research',
    /research|^(market|strategy|strategy-review|audit-\d+|program-audit|krn-architecture-program|krn-program-v2|roadmap-refill(-\d+)?|state-review|qwen-research(-\d+)?)$/,
    'research agents',
    'research findings and programme reviews',
    KEEP,
  ),
  category(
    'evals',
    /^(d23-.*|fr40-campaign|first-push-green|haiku-lane-ab|lead-model-replay|ledger-.*|context-.*|startup-context|token-.*|clause-proof|app-token-proof|subagent-spend|sibling-transplant)$/,
    'evals',
    'measured runs and proofs',
    KEEP,
  ),
  category(
    'pilot',
    /^(pilot(-py)?|py-rows|units-py|units-ts)$/,
    'pilot',
    'pilot and unit-transplant runs',
    KEEP,
  ),
  category(
    'tools',
    /^(claude|codex|hook|hook-errors|prune|outside|ci-platform|cc-watch|cc-.*)$/,
    'krn',
    'host tool and hook observations',
    KEEP,
  ),
];

function entry(
  name: string,
  kind: 'dir' | 'file',
  owner: string,
  purpose: string,
  retention: Retention,
): LayoutEntry {
  return { name, kind, owner, purpose, retention };
}

function category(
  name: string,
  match: RegExp,
  owner: string,
  purpose: string,
  retention: Retention,
): RunCategory {
  return { name, match, owner, purpose, retention };
}

export const STRAY_DIRECTORY = join('tmp', 'stray');
const DAY = 86_400_000;

export interface TidyMove {
  from: string;
  to: string;
}
export interface TidyDelete {
  path: string;
  bytes: number;
  reason: string;
}
export interface TidyPlan {
  moves: TidyMove[];
  deletes: TidyDelete[];
  bytes: number;
}

function newest(path: string, deep: boolean): number {
  const stat = lstatSync(path);
  let latest = stat.mtimeMs;
  if (!deep || !stat.isDirectory()) return latest;
  for (const name of readdirSync(path))
    latest = Math.max(latest, newest(join(path, name), true));
  return latest;
}

function size(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of readdirSync(path)) total += size(join(path, name));
  return total;
}

function expired(
  path: string,
  retention: Retention,
  now: number,
  deep: boolean,
): boolean {
  return (
    retention !== 'keep' && now - newest(path, deep) > retention.days * DAY
  );
}

function strayTarget(directory: string, from: string): string {
  const flat = from.split('/').join('__');
  let target = join(STRAY_DIRECTORY, flat);
  for (let at = 2; existsSync(join(directory, target)); at += 1)
    target = join(STRAY_DIRECTORY, `${flat}.${at}`);
  return target;
}

/** What tidy would move and delete in `directory` (a .krn/ directory); reads only. */
export function planTidy(directory: string, now = Date.now()): TidyPlan {
  const plan: TidyPlan = { moves: [], deletes: [], bytes: 0 };
  if (!existsSync(directory)) return plan;
  const claimed = new Set<string>();
  const stray = (from: string) => {
    const to = strayTarget(directory, from);
    // Two strays flattening to one name cannot happen: separators differ from '__' in real names.
    plan.moves.push({ from, to });
    claimed.add(to);
  };
  for (const name of readdirSync(directory).sort()) {
    const declared = TOP_LEVEL.find((item) => item.name === name);
    const stat = lstatSync(join(directory, name));
    if (!declared || (declared.kind === 'dir') !== stat.isDirectory()) {
      stray(name);
      continue;
    }
    const full = join(directory, name);
    if (name === 'runs') {
      for (const owner of readdirSync(full).sort()) {
        const path = join(full, owner);
        const found = RUN_CATEGORIES.find((item) => item.match.test(owner));
        if (!found || !lstatSync(path).isDirectory()) {
          stray(`runs/${owner}`);
        } else
          for (const child of readdirSync(path).sort()) {
            const childPath = join(path, child);
            if (expired(childPath, found.retention, now, true))
              plan.deletes.push({
                path: `runs/${owner}/${child}`,
                bytes: size(childPath),
                reason: `${found.name} retention`,
              });
          }
      }
    } else if (name === 'tmp') {
      for (const child of readdirSync(full).sort()) {
        const path = join(full, child);
        if (expired(path, declared.retention, now, false))
          plan.deletes.push({
            path: `tmp/${child}`,
            bytes: size(path),
            reason: 'tmp retention',
          });
      }
    }
  }
  plan.bytes =
    plan.deletes.reduce((sum, item) => sum + item.bytes, 0) +
    plan.moves.reduce((sum, item) => sum + size(join(directory, item.from)), 0);
  return plan;
}

/** Layout violations as one line each, for `krn state check`. */
export function layoutFindings(
  directory: string,
  now = Date.now(),
): { rule: string; detail: string }[] {
  const plan = planTidy(directory, now);
  return [
    ...plan.moves.map((move) => ({
      rule: 'outside-layout',
      detail: `.krn/${move.from} is not in the declared layout; \`krn state tidy\` moves it to .krn/${move.to}`,
    })),
    ...plan.deletes.map((item) => ({
      rule: 'past-retention',
      detail: `.krn/${item.path} is past its ${item.reason}; \`krn state tidy\` deletes it`,
    })),
  ];
}

/** Applies the plan: moves strays under tmp/stray (fresh mtime so retention counts from the move), deletes expired data, rewrites INDEX.md. */
export function applyTidy(directory: string, now = Date.now()): TidyPlan {
  const plan = planTidy(directory, now);
  mkdirSync(join(directory, STRAY_DIRECTORY), { recursive: true });
  for (const item of plan.deletes)
    rmSync(join(directory, item.path), { recursive: true, force: true });
  for (const move of plan.moves) {
    renameSync(join(directory, move.from), join(directory, move.to));
    const stamp = new Date(now);
    utimesSync(join(directory, move.to), stamp, stamp);
  }
  writeLayoutIndex(directory);
  return plan;
}

const retentionText = (retention: Retention) =>
  retention === 'keep' ? 'keep' : `${retention.days} days`;

/** Regenerates INDEX.md: each entry with owner, purpose, retention, size and last write. */
export function writeLayoutIndex(directory: string): string {
  if (!existsSync(directory)) return '';
  const day = (time: number) => new Date(time).toISOString().slice(0, 10);
  const rows = (
    heading: string,
    base: string,
    items: {
      name: string;
      owner: string;
      purpose: string;
      retention: Retention;
    }[],
    present: (name: string) => string | undefined,
    deep: boolean,
  ) => {
    const lines = [
      `## ${heading}`,
      '',
      '| entry | owner | purpose | retention | size | last write |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
    for (const item of items) {
      const found = present(item.name);
      if (found === undefined) continue;
      const path = join(base, found);
      const huge = found === 'sources' || found === 'worktrees';
      lines.push(
        `| ${found} | ${item.owner} | ${item.purpose} | ${retentionText(item.retention)} | ${huge ? 'not measured' : `${size(path)} B`} | ${day(newest(path, deep && !huge))} |`,
      );
    }
    return lines.join('\n');
  };
  const top = new Set(readdirSync(directory));
  const owners = existsSync(join(directory, 'runs'))
    ? readdirSync(join(directory, 'runs')).sort()
    : [];
  const runRows = owners.flatMap((owner) => {
    const found = RUN_CATEGORIES.find((item) => item.match.test(owner));
    return found
      ? [
          {
            name: owner,
            owner: found.owner,
            purpose: `${found.name}: ${found.purpose}`,
            retention: found.retention,
          },
        ]
      : [];
  });
  const text = `${[
    '# .krn index',
    '',
    'Generated by `krn state tidy`; edit src/state/layout.ts, not this file.',
    '',
    rows(
      'Top level',
      directory,
      [...TOP_LEVEL],
      (name) => (top.has(name) && name !== 'INDEX.md' ? name : undefined),
      true,
    ),
    '',
    rows(
      'runs/',
      join(directory, 'runs'),
      runRows,
      (name) => (owners.includes(name) ? name : undefined),
      true,
    ),
  ].join('\n')}\n`;
  const file = join(directory, 'INDEX.md');
  writeFileSync(file, text);
  return file;
}
