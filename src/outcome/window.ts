// The delivery window unit: merged PRs, dollars by session class, PRs per task, lead time, CI attempts, rework and main reds.
import { resolve } from 'node:path';
import { transcriptDirs } from '../harness/transcripts.ts';
import { frameChanges, gateManifest } from './gate-manifest.ts';
import {
  classifyLead,
  HOLDINGS,
  type Holding,
  holdingOf,
  sessionMarkers,
} from './holdings.ts';
import {
  array,
  callRun,
  internalError,
  number,
  object,
  parse,
  type Run,
  round,
  sessions,
  string,
  time,
} from './ledger.ts';
import { dollarsPerPoint, readPlanPoints } from './plan-gauge.ts';
import { fixChangesIntroducedLines } from './rework-blame.ts';
import { type Turn, turnDollars } from './slice-cost.ts';
import { titleTaskId } from './task-id.ts';

type Value = number | null;

export type WindowOptions = {
  from?: string;
  to?: string;
  last?: number;
  root?: string;
  transcripts?: string;
  repo?: string;
  run?: Run;
  /** Whether `fix` changes lines `introduced` added; defaults to git blame in `root`. */
  blamed?: (
    introduced: string,
    fix: string,
    files: string[],
  ) => Promise<boolean>;
};
const percentile = (values: number[], p: number): Value => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0
    ? null
    : (sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null);
};
/**
 * A PR is lane-authored when its body names a headless claude session (the
 * `krn lane run` body) or carries the `Lane: krn lane brief` line (`krn pr body --lane`) or its branch has a worktree transcript directory that
 * holds a session launched as a lane. Everything else is the standing lead's.
 */
export function isLanePr(
  pr: { body: string; branch: string },
  laneDirs: ReadonlySet<string>,
): boolean {
  return (
    /^Agent: headless claude session/m.test(pr.body) ||
    /^Lane: krn lane brief$/m.test(pr.body) ||
    laneDirs.has(pr.branch.replace(/[^a-zA-Z0-9]/g, '-'))
  );
}
const usd = (v: number) => Math.round(v * 100) / 100;
/**
 * A window is measured by the main checkout's code and data. A linked worktree
 * runs its own `src`, so a lane could author the measure of its own work, and
 * its transcript directory holds one lane, so the dollars would read $0.00.
 * Returns the refusal reason when `root` is a linked worktree, else null.
 */
const git = async (root: string, args: string[]) => {
  try {
    return (await callRun(10_000)('git', ['-C', root, ...args])).trim();
  } catch {
    return null;
  }
};
async function linkedWorktreeRefusal(root: string): Promise<string | null> {
  const dir = await git(root, ['rev-parse', '--absolute-git-dir']);
  const common = await git(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!dir || !common || resolve(dir) === resolve(common)) return null;
  const list = await git(root, ['worktree', 'list', '--porcelain']);
  const main =
    /^worktree (.+)$/m.exec(list ?? '')?.[1] ?? resolve(common, '..');
  return `${root} is a linked worktree: the window runs on the main checkout's code and data. Run \`krn ledger --window ...\` from ${main}, or pass --root ${main}.`;
}
/**
 * One window of delivery: merged PRs, dollars by session class, PRs per task,
 * lead time, CI attempts, rework and main reds, from GitHub, git-free gh calls
 * and local transcripts. Turns are priced by their own timestamp, as
 * scripts/claude/spend-window.py does.
 */
export async function collectWindow(options: WindowOptions) {
  const root = resolve(options.root ?? process.cwd());
  const refusal = await linkedWorktreeRefusal(root);
  if (refusal) throw Object.assign(new Error(refusal), { exitCode: 64 });
  // Window lists are large (1000 runs or PRs with files), so a call may take longer than a row fetch.
  const run = options.run ?? callRun(90_000);
  const manifest = gateManifest(root);
  const t0 = Date.now();
  const repo =
    options.repo ??
    string(
      object(
        parse(await run('gh', ['repo', 'view', '--json', 'nameWithOwner'])),
      ).nameWithOwner,
    );
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw internalError('Invalid repository');
  const json = async (args: string[]) => array(parse(await run('gh', args)));
  let from = Date.parse(options.from ?? '');
  let to = Date.parse(options.to ?? '');
  if (options.last !== undefined) {
    const recent = (
      await json([
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'merged',
        '--limit',
        String(options.last),
        '--json',
        'mergedAt',
      ])
    )
      .map((p) => time(object(p).mergedAt))
      .filter((v): v is number => v !== null);
    from = Math.min(...recent);
    to = Math.max(...recent) + 1;
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
    throw internalError('Invalid window');
  const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
  // Everything merged from the window start on, so a later fix PR can be matched.
  const fetched = (
    await json([
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'merged',
      '--limit',
      '1000',
      '--search',
      `merged:>=${iso(from)}`,
      '--json',
      'number,title,body,createdAt,mergedAt,headRefName,files,mergeCommit',
    ])
  ).map(object);
  const rows = fetched
    .map((p) => ({
      number: Number(p.number),
      title: string(p.title),
      created: time(p.createdAt),
      merged: time(p.mergedAt),
      branch: string(p.headRefName),
      oid: string(object(p.mergeCommit).oid),
      body: typeof p.body === 'string' ? p.body : '',
      files: array(p.files).map((f) => string(object(f).path)),
      frame: frameChanges(
        array(p.files).map((f) => ({
          path: string(object(f).path),
          lines:
            (number(object(f).additions) ?? 0) +
            (number(object(f).deletions) ?? 0),
        })),
        manifest,
      ),
    }))
    .filter((p) => p.merged !== null && p.created !== null) as {
    number: number;
    title: string;
    created: number;
    merged: number;
    branch: string;
    oid: string;
    body: string;
    files: string[];
    frame: ReturnType<typeof frameChanges>;
  }[];
  const inWindow = rows
    .filter((p) => p.merged >= from && p.merged < to)
    .sort((a, b) => a.merged - b.merged);
  const github = Date.now() - t0;
  // Spend, split by session class.
  const t1 = Date.now();
  const dirs = options.transcripts
    ? [options.transcripts]
    : await transcriptDirs(root);
  const classes = new Map<
    string,
    { dollars: number; turns: number; sessions: number }
  >();
  const holds = new Map<
    Holding,
    { dollars: number; turns: number; sessions: number; estimated: number }
  >(
    HOLDINGS.map((h) => [
      h,
      { dollars: 0, turns: 0, sessions: 0, estimated: 0 },
    ]),
  );
  let unpriced = 0;
  const laneDirs = new Set<string>();
  const markers = await sessionMarkers(root);
  const book = (
    cls: string,
    turns: Turn[],
    hold: Holding,
    estimated: boolean,
  ) => {
    const own = turns.filter((t) => t.at !== null && t.at >= from && t.at < to);
    if (own.length === 0) return;
    const c = classes.get(cls) ?? { dollars: 0, turns: 0, sessions: 0 };
    c.sessions++;
    for (const turn of own) {
      const d = turnDollars(turn);
      if (d === null) unpriced++;
      else c.dollars += d;
      c.turns++;
    }
    classes.set(cls, c);
    const h = holds.get(hold);
    if (!h) return;
    h.sessions++;
    if (estimated) h.estimated++;
    for (const turn of own) {
      const d = turnDollars(turn);
      if (d !== null) h.dollars += d;
      h.turns++;
    }
  };
  for (const dir of dirs) {
    const found = await sessions([dir]);
    const where = dir.includes('--krn-worktrees-') ? 'worktree' : 'main';
    const leads = new Map(
      found.lead.map((s) => [
        s.id,
        classifyLead(markers.get(s.id), s.firstPrompt),
      ]),
    );
    for (const s of found.lead) {
      const c = leads.get(s.id);
      if (where === 'worktree' && c?.class === 'lane')
        laneDirs.add(dir.slice(dir.indexOf('--krn-worktrees-') + 16));
      if (c)
        book(
          `${c.class === 'lane' ? 'lane' : 'lead'}:${where}`,
          s.turns,
          holdingOf(c, null),
          c.estimated,
        );
    }
    for (const s of found.subagents) {
      const c = leads.get(s.lead ?? '');
      if (c) book(s.role, s.turns, holdingOf(c, s), c.estimated);
    }
  }
  const transcript = Date.now() - t1;
  const lead = [...classes].filter(([k]) => k.startsWith('lead:'));
  const lane = [...classes].filter(([k]) => k.startsWith('lane:'));
  const sub = [...classes].filter(([k]) => k.startsWith('subagent:'));
  const total = (list: typeof lead) =>
    list.reduce((n, [, c]) => n + c.dollars, 0);
  // PRs per task.
  const perTask = new Map<string, number>();
  let noTask = 0;
  for (const p of inWindow) {
    const t = titleTaskId(p.title);
    if (t) perTask.set(t, (perTask.get(t) ?? 0) + 1);
    else noTask++;
  }
  const leadMinutes = inWindow.map((p) => (p.merged - p.created) / 60000);
  // CI attempts: runs of the CI workflow on the PR branch, created while the PR was open, counting reruns.
  const ciRuns = (
    await json([
      'run',
      'list',
      '--repo',
      repo,
      '--workflow',
      'CI',
      '--event',
      'pull_request',
      '--created',
      `>=${iso(from - 7 * 86400000)}`,
      '--limit',
      '1000',
      '--json',
      'headBranch,createdAt,attempt',
    ])
  ).map(object);
  const attempts = inWindow.map((p) => {
    const own = ciRuns.filter((r) => {
      const at = time(r.createdAt) ?? 0;
      return (
        string(r.headBranch) === p.branch &&
        at >= p.created - 60000 &&
        at <= p.merged
      );
    });
    return own.reduce((n, r) => n + (number(r.attempt) ?? 1), 0);
  });
  // Rework: a later fix PR (within 48 h and inside the window, so a closed window's count never changes) that changes lines this PR introduced (git blame on the fix's parent), or a revert naming the title.
  const work = (f: string) => !f.startsWith('tasks/');
  const blamed =
    options.blamed ??
    ((intro: string, fix: string, files: string[]) =>
      fixChangesIntroducedLines(root, intro, fix, files));
  const reworked: typeof inWindow = [];
  for (const p of inWindow) {
    const mine = new Set(p.files.filter(work));
    const later = rows.filter(
      (q) =>
        q.number !== p.number &&
        q.merged > p.merged &&
        q.merged <= Math.min(p.merged + 48 * 3600000, to),
    );
    let hit = later.some(
      (q) => /^revert/i.test(q.title) && q.title.includes(p.title),
    );
    for (const q of later) {
      if (hit) break;
      const shared = q.files.filter((f) => mine.has(f));
      if (/^fix(\(|:|!)/i.test(q.title) && shared.length > 0 && p.oid && q.oid)
        hit = await blamed(p.oid, q.oid, shared);
    }
    if (hit) reworked.push(p);
  }
  const lanePrs = inWindow
    .filter((p) => isLanePr(p, laneDirs))
    .map((p) => p.number);
  // Main reds: failed CI runs on pushes to main.
  const reds = (
    await json([
      'run',
      'list',
      '--repo',
      repo,
      '--workflow',
      'CI',
      '--event',
      'push',
      '--branch',
      'main',
      '--status',
      'failure',
      '--created',
      `${iso(from)}..${iso(to - 1000)}`,
      '--limit',
      '200',
      '--json',
      'databaseId,createdAt',
    ])
  ).length;
  const plan = await readPlanPoints(root, from, to);
  return {
    window: { from: iso(from), to: iso(to) },
    plan,
    prs: inWindow.map((p) => p.number),
    dollars: {
      lead: usd(total(lead)),
      leadMain: usd(classes.get('lead:main')?.dollars ?? 0),
      leadWorktree: usd(classes.get('lead:worktree')?.dollars ?? 0),
      lanes: usd(total(lane)),
      subagents: usd(total(sub)),
      byClass: Object.fromEntries(
        [...classes].map(([k, c]) => [k, { ...c, dollars: usd(c.dollars) }]),
      ),
      holdings: HOLDINGS.map((name) => {
        const h = holds.get(name);
        return {
          name,
          sessions: h?.sessions ?? 0,
          estimated: h?.estimated ?? 0,
          turns: h?.turns ?? 0,
          dollars: usd(h?.dollars ?? 0),
        };
      }),
      unpricedTurns: unpriced,
      transcriptTurns: [...classes.values()].reduce((n, c) => n + c.turns, 0),
      transcriptDirs: dirs.length,
    },
    tasks: {
      count: perTask.size,
      withMorePrs: [...perTask.values()].filter((n) => n > 1).length,
      prsWithoutTask: noTask,
    },
    leadTimeMinutes: {
      median: round(percentile(leadMinutes, 0.5)),
      p90: round(percentile(leadMinutes, 0.9)),
    },
    checkAttempts: {
      total: attempts.reduce((n, v) => n + v, 0),
      prsNeedingMore: attempts.filter((n) => n > 1).length,
      prsWithoutRun: attempts.filter((n) => n === 0).length,
    },
    rework: {
      prs: reworked.map((p) => p.number),
      rate: inWindow.length ? reworked.length / inWindow.length : null,
    },
    authors: {
      lane: lanePrs,
      lead: inWindow.map((p) => p.number).filter((n) => !lanePrs.includes(n)),
    },
    frame: inWindow
      .filter((p) => p.frame.length > 0)
      .map((p) => ({ pr: p.number, changes: p.frame })),
    mainReds: reds,
    timingMs: { github, transcript },
  };
}
/** Operator decision 4 (program v2): non-delivery may take at most 30% of a rolling window of 50 merged PRs. */
export const NON_DELIVERY_CEILING = 0.3;
export const CEILING_WINDOW_PRS = 50;

/** Share of window dollars outside delivery against the ceiling; `over` is true only strictly above it. */
export function nonDeliveryCeiling(r: {
  dollars: { holdings: { name: string; dollars: number }[] };
}): { share: number; ceiling: number; over: boolean } | null {
  const cents = r.dollars.holdings.map((h) => ({
    name: h.name,
    cents: Math.round(h.dollars * 100),
  }));
  const all = cents.reduce((v, h) => v + h.cents, 0);
  if (all === 0) return null;
  const delivery = cents
    .filter((h) => h.name.startsWith('delivery'))
    .reduce((v, h) => v + h.cents, 0);
  const share = (all - delivery) / all;
  return {
    share,
    ceiling: NON_DELIVERY_CEILING,
    over: share > NON_DELIVERY_CEILING,
  };
}
/** The leading line: window total per merged PR, points per PR, and the share of dollars outside delivery. */
export function windowHeadline(r: {
  prs: number[];
  plan: { fiveHour: number } | null;
  dollars: {
    transcriptTurns: number;
    holdings: { name: string; dollars: number }[];
  };
}): string | null {
  const n = r.prs.length;
  const cents = r.dollars.holdings.map((h) => Math.round(h.dollars * 100));
  const all = cents.reduce((v, c) => v + c, 0);
  if (r.dollars.transcriptTurns === 0 || n === 0 || all === 0) return null;
  const delivery = r.dollars.holdings
    .filter((h) => h.name.startsWith('delivery'))
    .reduce((v, h) => v + Math.round(h.dollars * 100), 0);
  const other = all - delivery;
  const points = r.plan
    ? `${(r.plan.fiveHour / n).toFixed(2)} five-hour points/PR`
    : 'points/PR unknown';
  return `$${(all / 100 / n).toFixed(2)}/merged PR (window total $${(all / 100).toFixed(2)} over ${n} PRs), ${points}, non-delivery ${((other / all) * 100).toFixed(0)}% ($${(other / 100).toFixed(2)}); delivery only $${(delivery / 100 / n).toFixed(2)}/PR`;
}
export function renderWindow(r: Awaited<ReturnType<typeof collectWindow>>) {
  const d = r.dollars;
  const n = Math.max(r.prs.length, 1);
  const headline = windowHeadline(r);
  const lines = [
    ...(headline ? [headline] : []),
    `${r.window.from}..${r.window.to}: ${r.prs.length} PRs`,
  ];
  if (d.transcriptTurns === 0)
    lines.push(
      `NO TRANSCRIPT TURNS in the window (${d.transcriptDirs} transcript dirs searched): dollars are unknown, not $0.00; check --root or --transcripts`,
    );
  else {
    const delivery = d.holdings
      .filter((h) => h.name.startsWith('delivery'))
      .reduce((v, h) => v + h.dollars, 0);
    const all = d.holdings.reduce((v, h) => v + h.dollars, 0);
    lines.push(
      `window total $${all.toFixed(2)}: lead $${d.lead.toFixed(2)} (main $${d.leadMain.toFixed(2)}, worktree $${d.leadWorktree.toFixed(2)}), lane sessions $${d.lanes.toFixed(2)}, subagents $${d.subagents.toFixed(2)}; the lines below sum to it (each rounded to the cent)`,
    );
    for (const h of d.holdings)
      lines.push(
        `  ${h.name.padEnd(36)} $${h.dollars.toFixed(2).padStart(8)}  sessions=${h.sessions}${h.estimated ? ` (${h.estimated} classed by first prompt: estimated)` : ''}`,
      );
    lines.push(
      `per-PR figure counts delivery lines only: $${(delivery / n).toFixed(2)}/PR (delivery lead $${((d.holdings[0]?.dollars ?? 0) / n).toFixed(2)}); non-delivery sessions stay outside it`,
    );
  }
  for (const [k, c] of Object.entries(d.byClass).sort(
    (a, b) => b[1].dollars - a[1].dollars,
  ))
    lines.push(
      `  ${k.padEnd(28)} sessions=${String(c.sessions).padStart(3)} turns=${String(c.turns).padStart(5)} $${c.dollars.toFixed(2)}`,
    );
  if (r.plan) {
    const all = d.holdings.reduce((v, h) => v + h.dollars, 0);
    const per = dollarsPerPoint(all, r.plan);
    const fmt = (v: number | null) =>
      v === null ? 'unknown' : `$${v.toFixed(2)}`;
    lines.push(
      `plan gauge (${r.plan.samples} samples): five-hour ${r.plan.fiveHour} points = ${fmt(per.fiveHour)}/point, seven-day ${r.plan.sevenDay} points = ${fmt(per.sevenDay)}/point (window total over points; per account, attributes nothing)`,
    );
  }
  if (d.unpricedTurns) lines.push(`unpriced turns: ${d.unpricedTurns}`);
  lines.push(
    `tasks ${r.tasks.count}, with >1 PR ${r.tasks.withMorePrs}, PRs without task id ${r.tasks.prsWithoutTask}`,
    `lead time created->merged min: median ${r.leadTimeMinutes.median ?? 'unknown'}, p90 ${r.leadTimeMinutes.p90 ?? 'unknown'}`,
    `Check attempts (CI runs incl. reruns on the PR branch): total ${r.checkAttempts.total}, PRs needing >1 ${r.checkAttempts.prsNeedingMore}, PRs with no run found ${r.checkAttempts.prsWithoutRun}`,
    `rework within 48h: ${r.rework.prs.length} of ${r.prs.length} PRs${r.rework.rate === null ? '' : ` (${(r.rework.rate * 100).toFixed(0)}%)`}; lane PRs ${r.authors.lane.length}, lead PRs ${r.authors.lead.length}${r.rework.prs.length ? ` (${r.rework.prs.map((p) => `#${p}`).join(' ')})` : ''}`,
    `frame PRs (gate producers and task check code): ${r.frame.length}${r.frame.length ? ` (${r.frame.map((p) => `#${p.pr} ${p.changes.map((c) => `${c.path} ${c.class} ${c.lines}`).join(', ')}`).join('; ')})` : ''}`,
    `main reds: ${r.mainReds}`,
    `timing: github ${r.timingMs.github} ms, transcripts ${r.timingMs.transcript} ms`,
  );
  return `${lines.join('\n')}\n`;
}
