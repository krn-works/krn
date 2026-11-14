import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { promisify } from 'node:util';
import {
  subagentFiles,
  type TranscriptFile,
  transcriptDirs,
  transcriptFiles,
  transcriptLines,
} from '../harness/transcripts.ts';
import {
  REQUIRED_CHECK_APP_ID,
  REQUIRED_CHECK_NAME,
} from '../repo/ci-admission-contract.ts';
import { sessionMarkers } from './holdings.ts';
import {
  addedLines,
  classifyOutcome,
  LANE_ROLE,
  type Outcome,
  type SlicePr,
  sliceCosts,
  survivingLines,
  type Transcript,
  type Turn,
  usageOf,
} from './slice-cost.ts';

type Value = number | null;
type ObjectValue = Record<string, unknown>;
export const object = (v: unknown): ObjectValue =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as ObjectValue)
    : {};
export const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const number = (v: unknown): Value =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export const string = (v: unknown): string => (typeof v === 'string' ? v : '');
export const parse = (v: string): unknown => {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};
const sum = (values: Value[], empty: Value = null): Value =>
  values.length === 0
    ? empty
    : values.some((v) => v === null)
      ? null
      : values.reduce<number>((a, b) => a + (b ?? 0), 0);
export const time = (v: unknown): Value => {
  const n = Date.parse(string(v));
  return Number.isFinite(n) ? n : null;
};
const duration = (start: unknown, end: unknown): Value => {
  const a = time(start);
  const b = time(end);
  return a === null || b === null || b < a ? null : (b - a) / 60000;
};
export const round = (v: Value): Value =>
  v === null ? null : Math.round(v * 10) / 10;

export function reviewTotals(records: unknown[], repo: string, pr: number) {
  const attempts = new Map<string, ObjectValue>();
  for (const raw of records) {
    const r = object(raw);
    const a = object(r.attempt);
    if (a.repository === repo && a.pr === pr && string(a.id))
      attempts.set(string(a.id), r);
  }
  const totals = (key: string) =>
    sum(
      [...attempts.values()].map((r) =>
        !Array.isArray(r.judges)
          ? null
          : sum(
              r.judges.map((j) => {
                const usage = object(object(j).usage);
                return usage.state === 'observed'
                  ? number(object(usage.tokens)[key])
                  : null;
              }),
              0,
            ),
      ),
    );
  return {
    attempts: attempts.size || null,
    input: totals('inputTokens'),
    cached: totals('cachedInputTokens'),
    output: totals('outputTokens'),
  };
}

export function workerTotals(
  runs: unknown[][],
  hashes = new Map<unknown, string>(),
) {
  const seen = new Set<string>();
  const groups = runs
    .map((run) =>
      run.filter((raw) => {
        const hash =
          hashes.get(raw) ??
          createHash('sha256').update(JSON.stringify(raw)).digest('hex');
        if (seen.has(hash)) return false;
        seen.add(hash);
        return number(object(raw).round) !== null;
      }),
    )
    .filter((r) => r.length);
  const highest = groups.map((g) =>
    object(
      g.toSorted(
        (a, b) =>
          (number(object(b).round) ?? 0) - (number(object(a).round) ?? 0),
      )[0],
    ),
  );
  return {
    rounds: groups.reduce((n, g) => n + g.length, 0) || null,
    input: sum(highest.map((r) => number(object(r.cumulative).input))),
    cached: sum(highest.map((r) => number(object(r.cumulative).cached))),
    output: sum(highest.map((r) => number(object(r.cumulative).output))),
  };
}

type Tokens = {
  input: Value;
  cache_read: Value;
  cache_creation: Value;
  output: Value;
};
type Launch = { id: string; background: boolean; pr: number | null };
type Session = {
  /** Transcript file name without extension; empty for a parsed string. */
  id: string;
  tokens: Tokens;
  commands: string[];
  launches: Value[];
  launchPrs: (number | null)[];
  turns: Turn[];
  malformed: boolean;
  /** Text of the first operator-or-launcher prompt, cut to 400 characters; empty when none was read. */
  firstPrompt: string;
};
const unknownTokens = (): Tokens => ({
  input: null,
  cache_read: null,
  cache_creation: null,
  output: null,
});
function prArgument(command: string): number | null {
  const match = /--pr\s+(\d+)\b/.exec(command);
  return match ? Number(match[1]) : null;
}
function sessionParser(sidechain = false) {
  const messages = new Map<string, ObjectValue>();
  const turns = new Map<string, Turn>();
  const tools = new Map<string, Launch>();
  const commands = new Map<string, string>();
  const results = new Map<string, ObjectValue>();
  let malformed = false;
  let firstPrompt = '';
  return {
    line(line: string) {
      if (!line.trim()) return;
      const parsed = parse(line);
      if (parsed === null) malformed = true;
      const r = object(parsed);
      if (r.isSidechain === true && !sidechain) return;
      const m = object(r.message);
      if (!firstPrompt && r.type === 'user' && r.isMeta !== true) {
        const text = (
          typeof m.content === 'string'
            ? m.content
            : array(m.content)
                .map((c) => string(object(c).text))
                .join('\n')
        ).trim();
        if (text && !text.startsWith('<')) firstPrompt = text.slice(0, 400);
      }
      let turn: Turn | undefined;
      if (string(m.id) && m.role === 'assistant' && m.usage != null) {
        messages.set(string(m.id), object(m.usage));
        turn = turns.get(string(m.id)) ?? {
          model: '',
          usage: usageOf(null),
          at: time(r.timestamp),
          text: '',
          tools: [],
        };
        turn.model = string(m.model) || turn.model;
        turn.usage = usageOf(m.usage);
        turns.set(string(m.id), turn);
      }
      for (const raw of array(m.content)) {
        const c = object(raw);
        const input = object(c.input);
        if (turn && c.type === 'tool_use' && string(c.id))
          turn.tools.push(string(c.id));
        if (
          turn &&
          c.type === 'tool_use' &&
          c.name === 'Bash' &&
          typeof input.command === 'string'
        )
          turn.text += `${input.command}\n`;
        if (
          c.type === 'tool_use' &&
          c.name === 'Bash' &&
          string(c.id) &&
          typeof input.command === 'string'
        ) {
          commands.set(string(c.id), input.command);
          if (
            /\bkrn deliver\b/.test(input.command) &&
            !/--dry-run\b/.test(input.command)
          )
            tools.set(string(c.id), {
              id: string(c.id),
              background: input.run_in_background === true,
              pr: prArgument(input.command),
            });
        }
        if (c.type === 'tool_result' && string(c.tool_use_id))
          results.set(string(c.tool_use_id), c);
      }
    },
    finish(): Session {
      // A transcript line that does not parse may hold usage: the session totals become unknown.
      const total = (key: string) =>
        malformed
          ? null
          : sum([...messages.values()].map((m) => number(m[key])));
      return {
        id: '',
        tokens: {
          input: total('input_tokens'),
          cache_read: total('cache_read_input_tokens'),
          cache_creation: total('cache_creation_input_tokens'),
          output: total('output_tokens'),
        },
        commands: [...commands.values()],
        turns: [...turns.values()],
        malformed,
        firstPrompt,
        launchPrs: [...tools.values()].map((t) => t.pr),
        launches: [...tools.values()].map((t) => {
          const r = results.get(t.id);
          if (!r) return null;
          const text =
            typeof r.content === 'string'
              ? r.content
              : array(r.content)
                  .map((c) => string(object(c).text))
                  .join('\n');
          const markers = [...text.matchAll(/\b(?:deliver|exit)=(\d+)\b/g)];
          const marker = markers.at(-1);
          if (marker) return Number(marker[1]);
          if (r.is_error === true) {
            const code = /^Exit code (\d+)/m.exec(text);
            return code ? Number(code[1]) : null;
          }
          return t.background ? null : 0;
        }),
      };
    },
  };
}
export function parseTranscript(lines: Iterable<string>): Session {
  const parser = sessionParser();
  for (const line of lines) parser.line(line);
  return parser.finish();
}
export function attributeSession(
  session: Session,
  prs: { number: number; title: string }[],
): number | null {
  const scores = prs
    .map((pr) => {
      const task = /\(t-[0-9a-z]{7}\)\s*$/
        .exec(pr.title)?.[0]
        .trim()
        .slice(1, -1);
      let score = 0;
      for (const command of session.commands) {
        if (task)
          score += [...command.matchAll(new RegExp(`\\b${task}\\b`, 'g'))]
            .length;
        score += [
          ...command.matchAll(
            new RegExp(`(?:--pr\\s+${pr.number}\\b|#${pr.number}\\b)`, 'g'),
          ),
        ].length;
      }
      return { number: pr.number, score };
    })
    .sort((a, b) => b.score - a.score);
  return !scores[0]?.score || scores[0].score === scores[1]?.score
    ? null
    : scores[0].number;
}

export function gateTotals(responses: unknown[]) {
  if (
    !responses.length ||
    responses.some((r) => !Array.isArray(object(r).check_runs))
  )
    return { runs: null, reruns: null, minutes: null };
  const groups = responses.map((r) =>
    array(object(r).check_runs)
      .map(object)
      .filter(
        (c) =>
          c.name === REQUIRED_CHECK_NAME &&
          object(c.app).id === REQUIRED_CHECK_APP_ID,
      ),
  );
  const runs = groups.flat();
  return {
    runs: runs.length || null,
    reruns: runs.length
      ? groups.reduce((n, g) => n + Math.max(0, g.length - 1), 0)
      : null,
    minutes: round(
      sum(runs.map((r) => duration(r.started_at, r.completed_at))),
    ),
  };
}

export type Run = (cmd: string, args: string[]) => string | Promise<string>;
const exec = promisify(execFile);
/**
 * GitHub calls answer in about 0.7 s but sometimes hang (one took 218 s) or
 * fail a TLS handshake; a call ends after this and is tried again.
 */
const CALL_TIMEOUT_MS = 5_000;
// Not the shared deliver/transport github(): that one is spawnSync and would
// block the event loop, losing the concurrent row fetch that keeps this fast.
const CALL_ATTEMPTS = 3;
export const callRun =
  (timeout: number): Run =>
  async (cmd, args) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return (
          await exec(cmd, args, {
            maxBuffer: 16 * 1024 * 1024,
            timeout,
          })
        ).stdout;
      } catch (error) {
        if (attempt >= CALL_ATTEMPTS) throw error;
      }
    }
  };
const defaultRun = callRun(CALL_TIMEOUT_MS);
/** PR rows fetched at once: each row waits on GitHub calls, not on CPU. */
const ROW_CONCURRENCY = 12;
/** Transcript files read at once. */
const FILE_CONCURRENCY = 8;
/** Map items with at most `limit` in flight, keeping input order. */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  f: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await f(items[i] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
export type LedgerOptions = {
  root?: string;
  transcripts?: string;
  repo?: string;
  since?: string;
  pr?: number;
  limit?: number;
  run?: Run;
  /** Clock for the seven-day outcome window. */
  now?: number;
};
async function isPlainFile(path: string) {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}
// Worker evidence is read only from real directories under the repository root.
async function realDirectoryInside(root: string, dir: string) {
  try {
    const [realRoot, realDir] = await Promise.all([
      realpath(root),
      realpath(dir),
    ]);
    const inside = relative(realRoot, realDir);
    if (inside.startsWith('..') || isAbsolute(inside)) return null;
    return (await lstat(realDir)).isDirectory() ? realDir : null;
  } catch {
    return null;
  }
}
async function read(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}
async function walk(
  root: string,
  depth = 0,
): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  try {
    if (!(await lstat(root)).isDirectory()) return { files, dirs };
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isFile()) files.push(path);
      else if (entry.isDirectory() && depth < 8) {
        dirs.push(path);
        const nested = await walk(path, depth + 1);
        files.push(...nested.files);
        dirs.push(...nested.dirs);
      }
    }
  } catch {
    /* Missing or concurrently removed evidence remains unknown. */
  }
  return { files, dirs };
}
async function readSession(file: TranscriptFile, sidechain = false) {
  const parser = sessionParser(sidechain);
  try {
    for await (const line of transcriptLines(file.path)) parser.line(line);
    return { ...parser.finish(), id: file.id };
  } catch {
    /* One unreadable transcript does not abort the report. */
    return null;
  }
}
// Lead sessions are the top-level transcripts; each session's subagents live in <session>/subagents/.
export async function sessions(paths: string[]) {
  const files = await transcriptFiles(paths);
  // Files are read concurrently so disk waits overlap; results keep file order.
  const entries = await mapLimited(files, FILE_CONCURRENCY, async (file) => {
    const session = await readSession(file);
    if (!session) return null;
    const subs = await subagentFiles(file.path);
    const subagents = await mapLimited(subs, FILE_CONCURRENCY, async (sub) => {
      const parsed = await readSession(sub, true);
      if (!parsed) return null;
      const meta = object(parse(sub.meta));
      const transcript: Transcript = {
        role: `subagent:${string(meta.agentType) || 'unknown'}`,
        turns: parsed.turns,
        malformed: parsed.malformed,
        lead: file.id,
        ...(string(meta.toolUseId)
          ? { parentTool: string(meta.toolUseId) }
          : {}),
      };
      return transcript;
    });
    return { session, subagents };
  });
  const lead: Session[] = [];
  const subagents: Transcript[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    lead.push(entry.session);
    for (const sub of entry.subagents) if (sub) subagents.push(sub);
  }
  return { lead, subagents };
}
const OUTCOME_DAYS = 7;
/**
 * A merged PR's outcome after seven days on the checkout's first-parent
 * history: reverted, changed (some added lines no longer blame to it) or kept.
 */
async function outcome(
  run: Run,
  root: string,
  now: number,
  pr: SlicePr & { merge: string },
): Promise<Outcome> {
  const merged = time(pr.mergedAt);
  if (!pr.merge || merged === null) return { status: 'unknown' };
  const until = merged + OUTCOME_DAYS * 86_400_000;
  if (until > now) return { status: 'pending' };
  const git = (...args: string[]) =>
    Promise.resolve(run('git', ['-C', root, ...args]));
  try {
    const end = (
      await git(
        'rev-list',
        '-1',
        '--first-parent',
        `--before=${new Date(until).toISOString()}`,
        'HEAD',
      )
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(end)) return { status: 'unknown' };
    const subjects = await git('log', '--format=%s', `${pr.merge}..${end}`);
    const reverted = subjects
      .split('\n')
      .some(
        (s) =>
          /^Revert\b/.test(s) &&
          (s.includes(`#${pr.number}`) || s.includes(pr.title)),
      );
    const added = addedLines(
      await git('show', '--numstat', '--format=', pr.merge),
    );
    let total = 0;
    let surviving = 0;
    for (const [file, lines] of added) {
      total += lines;
      try {
        surviving += Math.min(
          lines,
          survivingLines(
            await git('blame', '--incremental', end, '--', file),
            pr.merge,
          ),
        );
      } catch {
        /* A file deleted since keeps none of its lines. */
      }
    }
    return classifyOutcome(total, surviving, reverted);
  } catch {
    return { status: 'unknown' };
  }
}
export function internalError(message: string) {
  return Object.assign(new Error(message), { exitCode: 70 });
}
export async function collectLedger(options: LedgerOptions = {}) {
  const root = resolve(options.root ?? process.cwd());
  const run = options.run ?? defaultRun;
  let repo = options.repo;
  let list: unknown;
  try {
    repo ??= string(
      object(
        parse(await run('gh', ['repo', 'view', '--json', 'nameWithOwner'])),
      ).nameWithOwner,
    );
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repository');
    list = parse(
      await run('gh', [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'merged',
        '--limit',
        // Older PRs bound the slices of the reported ones in shared sessions.
        String((options.limit ?? 15) + 20),
        '--json',
        'number,title,createdAt,mergedAt,headRefOid,baseRefOid,mergeCommit',
      ]),
    );
    if (!Array.isArray(list)) throw new Error('PR list');
  } catch {
    throw internalError('Unable to read merged PR list with gh');
  }
  const prs = array(list)
    .map(object)
    .filter((p) => number(p.number) !== null && time(p.mergedAt) !== null)
    .map((p) => ({
      number: Number(p.number),
      title: string(p.title),
      createdAt: p.createdAt,
      mergedAt: p.mergedAt,
      merge: string(object(p.mergeCommit).oid),
    }))
    .sort((a, b) => (time(b.mergedAt) ?? 0) - (time(a.mergedAt) ?? 0));
  // One request per commit, shared by concurrent rows.
  const gates = new Map<string, Promise<unknown>>();
  const gate = (sha: string): Promise<unknown> => {
    if (!sha) return Promise.resolve(null);
    const cached = gates.get(sha);
    if (cached) return cached;
    const pending = Promise.resolve()
      .then(() =>
        run('gh', [
          'api',
          `repos/${repo}/commits/${sha}/check-runs?filter=all&per_page=100`,
        ]),
      )
      .then(parse, () => null);
    gates.set(sha, pending);
    return pending;
  };
  const selected = [...prs.entries()]
    .filter(
      ([, pr]) =>
        (options.pr === undefined || pr.number === options.pr) &&
        (!options.since ||
          (time(pr.mergedAt) ?? 0) >= Date.parse(options.since)),
    )
    .slice(0, options.limit ?? 15);
  // GitHub answers arrive while the transcripts below are read.
  const github = mapLimited(selected, ROW_CONCURRENCY, async ([, pr]) => {
    let commits: unknown[] | null = null;
    try {
      const response = object(
        parse(
          await run('gh', [
            'pr',
            'view',
            String(pr.number),
            '--repo',
            repo,
            '--json',
            'commits',
          ]),
        ),
      );
      if (Array.isArray(response.commits)) commits = response.commits;
    } catch {
      /* Unknown PR gate. */
    }
    const shas = commits
      ? [...new Set(commits.map((c) => string(object(c).oid)))]
      : [];
    return {
      prGate: gateTotals(await Promise.all(shas.map(gate))),
      mainGate: gateTotals([await gate(pr.merge)]),
    };
  });
  const runs = await walk(join(root, '.krn/runs'));
  const archive = await walk(join(root, '.krn/archive'));
  const records = await Promise.all(
    [...runs.files, ...archive.files]
      .filter((p) =>
        /(?:^|\/)review-series(?:\/[^/]+|-.*)\/records\/[^/]+\.json$/.test(p),
      )
      .map(async (p) => parse(await read(p))),
  );
  const all: Session[] = [];
  const attributed = new Map<number, Session[]>();
  const transcripts = await sessions(
    options.transcripts ? [options.transcripts] : await transcriptDirs(root),
  );
  const markers = await sessionMarkers(root);
  const costs = sliceCosts(
    transcripts.lead.map((s) => ({
      role: markers.get(s.id) === 'lane' ? LANE_ROLE : 'lead',
      turns: s.turns,
      malformed: s.malformed,
    })),
    transcripts.subagents,
    prs,
  );
  for (const session of transcripts.lead) {
    all.push(session);
    const pr = attributeSession(session, prs);
    if (pr !== null)
      attributed.set(pr, [...(attributed.get(pr) ?? []), session]);
  }
  const rows = await mapLimited(
    selected.map((entry, position) => [position, ...entry] as const),
    ROW_CONCURRENCY,
    async ([position, index, pr]) => {
      const checks = (await github)[position];
      if (!checks) throw new Error(`no GitHub row for #${pr.number}`);
      const task = /\((t-[0-9a-z]{7})\)\s*$/.exec(pr.title)?.[1];
      const dirs = new Set<string>();
      if (task) {
        for (const dir of runs.dirs) if (basename(dir) === task) dirs.add(dir);
        const journalPath = join(root, '.krn/runs/slice', task, 'journal.json');
        const journal = (await isPlainFile(journalPath))
          ? object(parse(await read(journalPath)))
          : {};
        const briefDir = string(journal.brief)
          ? await realDirectoryInside(
              root,
              dirname(resolve(root, string(journal.brief))),
            )
          : null;
        if (briefDir) dirs.add(briefDir);
      }
      // Assign each metrics path to its closest run directory, avoiding nested-root double counting.
      const groups: unknown[][] = [];
      const hashes = new Map<unknown, string>();
      const seenPaths = new Set<string>();
      for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
        const metrics = [];
        const fromRuns = relative(join(root, '.krn/runs'), dir);
        const depth = fromRuns.startsWith('..')
          ? 0
          : fromRuns.split(sep).filter(Boolean).length;
        if (depth > 8) continue;
        for (const file of (await walk(dir, depth)).files) {
          if (
            !/(?:^|\/)rounds\/\d+\/metrics\.json$/.test(relative(dir, file)) ||
            seenPaths.has(file)
          )
            continue;
          seenPaths.add(file);
          const content = await read(file);
          const raw = parse(content);
          if (raw !== null) {
            hashes.set(raw, createHash('sha256').update(content).digest('hex'));
            metrics.push(raw);
          }
        }
        groups.push(metrics);
      }
      const own = attributed.get(pr.number) ?? [];
      const cost = costs.get(pr.number);
      const lead: Tokens = cost?.leadTokens ?? unknownTokens();
      // A deliver launch belongs to the PR its `--pr` names, in any session; one without `--pr` belongs to its session's PR.
      const launches = all.flatMap((s) =>
        s.launches.filter(
          (_, i) =>
            s.launchPrs[i] === pr.number ||
            (s.launchPrs[i] === null && own.includes(s)),
        ),
      );
      if (task) {
        const exit = (
          await read(join(root, '.krn/runs/slice', task, 'landing.exit'))
        ).trim();
        if (/^\d+$/.test(exit)) launches.push(Number(exit));
      }
      return {
        number: pr.number,
        title: pr.title,
        task: task ?? null,
        openToMergeMinutes: round(duration(pr.createdAt, pr.mergedAt)),
        mergeToMergeMinutes: round(
          duration(prs[index + 1]?.mergedAt, pr.mergedAt),
        ),
        ...checks,
        review: reviewTotals(records, repo, pr.number),
        worker: workerTotals(groups, hashes),
        deliver: launches.length ? launches : null,
        lead,
        leadUncachedInput: sum([lead.input, lead.cache_creation]),
        cost: cost ?? null,
        outcome: await outcome(run, root, options.now ?? Date.now(), pr),
      };
    },
  );
  const median = (values: Value[]) => {
    const known = values
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    const mid = Math.floor(known.length / 2);
    return {
      value: known.length
        ? ((known[mid] ?? 0) + (known[known.length % 2 ? mid : mid - 1] ?? 0)) /
          2
        : null,
      n: known.length,
    };
  };
  return {
    rows,
    medians: {
      mergeToMergeMinutes: median(rows.map((r) => r.mergeToMergeMinutes)),
      openToMergeMinutes: median(rows.map((r) => r.openToMergeMinutes)),
      prGateMinutes: median(rows.map((r) => r.prGate.minutes)),
      leadUncachedInput: median(rows.map((r) => r.leadUncachedInput)),
      leadCacheRead: median(rows.map((r) => r.lead.cache_read)),
      dollars: median(rows.map((r) => r.cost?.dollars ?? null)),
      subagentDollars: median(rows.map((r) => r.cost?.subagentDollars ?? null)),
      judgeInput: median(rows.map((r) => r.review.input)),
      workerInput: median(rows.map((r) => r.worker.input)),
    },
  };
}
function outcomeText(o: Outcome): string {
  return 'added' in o
    ? `${o.status} (${o.surviving}/${o.added} lines kept)`
    : o.status;
}
function deliveries(exits: Value[] | null): string {
  if (!exits) return 'unknown';
  const counts = new Map<string, number>();
  for (const exit of exits) {
    const key = exit === null ? 'unknown' : String(exit);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return `${exits.length} (${[...counts].map(([k, n]) => `${k}×${n}`).join(', ')})`;
}
export function renderLedger(
  report: Awaited<ReturnType<typeof collectLedger>>,
): string {
  const show = (v: Value) => (v === null ? 'unknown' : String(v));
  const gate = (g: ReturnType<typeof gateTotals>) =>
    [g.minutes, g.runs, g.reruns].map(show).join(' / ');
  const lines = [
    '| PR | Title | Open→merge min | Merge→merge min | PR gate min / runs / reruns | Main gate min / runs / reruns | Review attempts | Judge input / cached / output | Worker rounds | Worker input / cached / output | Deliver exits | Lead input / cache_read / cache_creation / output | $ total / lead / subagents | Author | 7-day outcome |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of report.rows)
    lines.push(
      `| ${[r.number, r.title.split(/[\r\n]/)[0]?.replaceAll('|', '\\|'), show(r.openToMergeMinutes), show(r.mergeToMergeMinutes), gate(r.prGate), gate(r.mainGate), show(r.review.attempts), [r.review.input, r.review.cached, r.review.output].map(show).join(' / '), show(r.worker.rounds), [r.worker.input, r.worker.cached, r.worker.output].map(show).join(' / '), deliveries(r.deliver), [r.lead.input, r.lead.cache_read, r.lead.cache_creation, r.lead.output].map(show).join(' / '), r.cost ? [r.cost.dollars, r.cost.leadDollars, r.cost.subagentDollars].map(show).join(' / ') : 'unknown', r.cost?.author ? `${r.cost.author.role} ${r.cost.author.model}` : 'unknown', outcomeText(r.outcome)].join(' | ')} |`,
    );
  lines.push('', '## Medians', '');
  for (const [key, m] of Object.entries(report.medians))
    lines.push(`- ${key}: ${show(m.value)} (n=${m.n})`);
  return `${lines.join('\n')}\n`;
}
