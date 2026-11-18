// Spend per delivered PR: the ledger's slice cost joined with first-push-green, as dollars per merged PR and per first-push-green PR.

import { transcriptDirs } from '../harness/transcripts.ts';
import { ghRepoView } from '../repo/gh.ts';
import {
  collectFirstPushGreen,
  type FirstPushGreen,
} from './first-push-green.ts';
import { sessionMarkers } from './holdings.ts';
import {
  callRun,
  collectLedger,
  type LedgerOptions,
  object,
  parse,
  sessions,
  string,
} from './ledger.ts';
import { LANE_ROLE, type Transcript, turnDollars } from './slice-cost.ts';

export type DollarsPerPr = {
  /** Merged PRs whose slice cost is known; the figures below cover exactly these. */
  merged: number;
  /** Merged PRs left out because no priced transcript turn or a malformed transcript left their cost unknown. */
  unpriced: number;
  /** Priced PRs whose first pushed head got a green Check. */
  firstPushGreen: number;
  /** Dollars spent on the priced PRs, green or not. */
  totalDollars: number;
  /** totalDollars / merged, or null when no PR is priced. */
  perMerged: number | null;
  /** totalDollars / firstPushGreen: the red PRs' spend is carried by the green ones. Null when none is green. */
  perFirstPushGreen: number | null;
};

/** Joins per-PR dollars with the first-push-green result of the same PRs. */
export function joinDollars(
  costs: { number: number; dollars: number | null }[],
  firstPush: FirstPushGreen,
): DollarsPerPr {
  const green = new Set(
    firstPush.prs.filter((p) => p.first === 'success').map((p) => p.number),
  );
  const priced = costs.filter(
    (c): c is { number: number; dollars: number } => c.dollars !== null,
  );
  const total = priced.reduce((n, c) => n + c.dollars, 0);
  const greens = priced.filter((c) => green.has(c.number)).length;
  return {
    merged: priced.length,
    unpriced: costs.length - priced.length,
    firstPushGreen: greens,
    totalDollars: total,
    perMerged: priced.length ? total / priced.length : null,
    perFirstPushGreen: greens ? total / greens : null,
  };
}

export async function collectDollars(
  options: LedgerOptions = {},
): Promise<DollarsPerPr> {
  const run = options.run ?? callRun(90_000);
  const repo =
    options.repo ?? string(object(parse(await ghRepoView(run))).nameWithOwner);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  const ledger = await collectLedger({ ...options, repo });
  const firstPush = await collectFirstPushGreen({
    numbers: ledger.rows.map((r) => r.number),
    repo,
    run,
  });
  return joinDollars(
    ledger.rows.map((r) => ({
      number: r.number,
      dollars: r.cost?.dollars ?? null,
    })),
    firstPush,
  );
}

export function renderDollars(d: DollarsPerPr): string {
  const money = (v: number | null) => (v === null ? 'n/a' : `$${v.toFixed(2)}`);
  return `${[
    `Dollars per merged PR: ${money(d.perMerged)} (${money(d.totalDollars)} over ${d.merged} priced merged PRs)`,
    `Dollars per first-push-green PR: ${money(d.perFirstPushGreen)} (${money(d.totalDollars)} over ${d.firstPushGreen} first-push-green PRs)`,
    `Merged PRs without a known cost: ${d.unpriced}`,
  ].join('\n')}\n`;
}

/** One priced turn charged to the task it worked on. */
export type AttemptSpend = {
  task: string;
  role: string;
  model: string;
  dollars: number;
};

/** The one task a turn's commands name; none when it names no task or several (a listing). */
function singleTask(text: string): string | undefined {
  const tasks = new Set(text.match(/\bt-[0-9a-z]{7}\b/g));
  return tasks.size === 1 ? [...tasks][0] : undefined;
}

/**
 * Every priced turn of every transcript, charged to the task it worked on:
 * the task the turn names alone, else the task of the transcript's previous
 * turn, else (a subagent) the task of the turn that launched it. Retries,
 * reviewers and work that never merged all stay charged to their task.
 */
export function attemptSpend(
  lead: Transcript[],
  subagents: Transcript[],
): { spend: AttemptSpend[]; unassigned: number; unpricedTurns: number } {
  const spend: AttemptSpend[] = [];
  const launched = new Map<string, string>();
  let unassigned = 0;
  let unpricedTurns = 0;
  const charge = (t: Transcript, parent: string | undefined) => {
    let current: string | undefined;
    for (const turn of t.turns) {
      current = singleTask(turn.text) ?? current;
      const task = current ?? parent;
      if (task) for (const id of turn.tools) launched.set(id, task);
      const dollars = turnDollars(turn);
      if (dollars === null) unpricedTurns++;
      else if (task)
        spend.push({ task, role: t.role, model: turn.model, dollars });
      else unassigned += dollars;
    }
  };
  for (const t of lead) charge(t, undefined);
  for (const t of subagents)
    charge(t, t.parentTool ? launched.get(t.parentTool) : undefined);
  return { spend, unassigned, unpricedTurns };
}

export type RouteDollars = {
  role: string;
  model: string;
  /** Assigned tasks this role and model spent on. */
  tasks: number;
  /** Of those tasks, the ones with an accepted merge. */
  accepted: number;
  /** All dollars this role and model spent on those tasks, merged or not. */
  dollars: number;
  /** dollars / accepted, or null when no task of the route was accepted. */
  perAccepted: number | null;
};
export type AllAttempts = {
  /** Tasks any priced turn was charged to. */
  assigned: number;
  accepted: number;
  /** Assigned tasks with no accepted merge, and what they cost. */
  abandoned: number;
  abandonedDollars: number;
  totalDollars: number;
  /** totalDollars / accepted: the abandoned work is carried by the accepted merges. */
  perAccepted: number | null;
  /** Dollars of turns that named no task, left out of every route. */
  unassignedDollars: number;
  unpricedTurns: number;
  routes: RouteDollars[];
};

/** Divides all assigned-task dollars by accepted merges, per role and model. */
export function joinAllAttempts(
  attempts: ReturnType<typeof attemptSpend>,
  acceptedTasks: Set<string>,
): AllAttempts {
  const byTask = new Map<string, number>();
  const byRoute = new Map<
    string,
    { role: string; model: string; dollars: number; tasks: Set<string> }
  >();
  for (const s of attempts.spend) {
    byTask.set(s.task, (byTask.get(s.task) ?? 0) + s.dollars);
    const key = `${s.role}\u0000${s.model}`;
    const route = byRoute.get(key) ?? {
      role: s.role,
      model: s.model,
      dollars: 0,
      tasks: new Set<string>(),
    };
    route.dollars += s.dollars;
    route.tasks.add(s.task);
    byRoute.set(key, route);
  }
  const accepted = [...byTask.keys()].filter((t) => acceptedTasks.has(t));
  const abandoned = [...byTask].filter(([t]) => !acceptedTasks.has(t));
  const total = [...byTask.values()].reduce((n, d) => n + d, 0);
  return {
    assigned: byTask.size,
    accepted: accepted.length,
    abandoned: abandoned.length,
    abandonedDollars: abandoned.reduce((n, [, d]) => n + d, 0),
    totalDollars: total,
    perAccepted: accepted.length ? total / accepted.length : null,
    unassignedDollars: attempts.unassigned,
    unpricedTurns: attempts.unpricedTurns,
    routes: [...byRoute.values()]
      .map((r) => {
        const won = [...r.tasks].filter((t) => acceptedTasks.has(t)).length;
        return {
          role: r.role,
          model: r.model,
          tasks: r.tasks.size,
          accepted: won,
          dollars: r.dollars,
          perAccepted: won ? r.dollars / won : null,
        };
      })
      .sort((a, b) => b.dollars - a.dollars),
  };
}

/** Merged PRs of a task count as accepted unless the outcome window saw the PR reverted. */
export async function collectAllAttempts(
  options: LedgerOptions = {},
): Promise<AllAttempts> {
  const run = options.run ?? callRun(90_000);
  const repo =
    options.repo ?? string(object(parse(await ghRepoView(run))).nameWithOwner);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  const root = options.root ?? process.cwd();
  const ledger = await collectLedger({ ...options, repo });
  const accepted = new Set(
    ledger.rows
      .filter((r) => r.task && r.outcome.status !== 'reverted')
      .map((r) => r.task as string),
  );
  const found = await sessions(
    options.transcripts ? [options.transcripts] : await transcriptDirs(root),
  );
  const markers = await sessionMarkers(root);
  return joinAllAttempts(
    attemptSpend(
      found.lead.map((s) => ({
        role: markers.get(s.id) === 'lane' ? LANE_ROLE : 'lead',
        turns: s.turns,
        malformed: s.malformed,
      })),
      found.subagents,
    ),
    accepted,
  );
}

export function renderAllAttempts(a: AllAttempts): string {
  const money = (v: number | null) => (v === null ? 'n/a' : `$${v.toFixed(2)}`);
  return `${[
    `Dollars per accepted merge, all attempts: ${money(a.perAccepted)} (${money(a.totalDollars)} over ${a.accepted} accepted tasks)`,
    `Assigned tasks: ${a.assigned}; accepted: ${a.accepted}; abandoned: ${a.abandoned} (${money(a.abandonedDollars)})`,
    `Dollars on turns naming no task: ${money(a.unassignedDollars)}; unpriced turns: ${a.unpricedTurns}`,
    'role | model | tasks | accepted | dollars | per accepted merge',
    ...a.routes.map(
      (r) =>
        `${r.role} | ${r.model} | ${r.tasks} | ${r.accepted} | ${money(r.dollars)} | ${money(r.perAccepted)}`,
    ),
  ].join('\n')}\n`;
}
