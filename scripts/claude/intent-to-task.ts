import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type Disposition,
  type InboxEntry,
  inboxRoot,
  isHarnessText,
  oneLine,
} from './operator-inbox-store.ts';

// Read-only measurement: of the operator prompts in a window, how many became a task, how many of
// those tasks closed done, and how long from the prompt to the first merge. The join is the
// disposition each prompt received (a task id in its ref), then the task record, then the first
// commit on main that names the task in a Ticket trailer (the closing one; Refs keeps a task open).
const usage =
  'Usage: node scripts/claude/intent-to-task.ts --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--root <repository>] [--rows]';

export type TaskState = { open: boolean; done: boolean };
export type Group =
  | 'harness'
  | 'automation'
  | 'task'
  | 'memory'
  | 'chat'
  | 'undisposed';
export type Row = {
  hash: string;
  time: string;
  text: string;
  group: Group;
  tasks: string[];
  allDone: boolean;
  anyOpen: boolean;
  openAfterDay: boolean;
  mergeHours?: number;
};
export type Input = {
  entries: InboxEntry[];
  dispositions: Disposition[];
  tasks: ReadonlyMap<string, TaskState>;
  // Merge times per task id, epoch milliseconds.
  merges: ReadonlyMap<string, number[]>;
  from: string;
  to: string;
  now: number;
};

// A disposition ref that says the prompt was written by a launcher or a harness, not by the operator.
const automationRef =
  /not an operator prompt|^(?:lead headless permission test|hand-fed|launch|launcher|successor|relay|standard resume|probe of session)|\b(?:launch|launcher|successor|relay) prompt/iu;
// The two launcher templates (successor-launch.ts --retire and context-relay's relay.sh): their prompts
// reach the inbox as rows although no operator wrote them.
const launcherText =
  /^(?:First run `node scripts\/claude\/successor-launch\.ts --retire`|You take over a long-running goal as its only writer\.)/u;
const taskId = /\bt-[a-z0-9]{7}\b/gu;
const hour = 3_600_000;

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const low = sorted[middle - 1] ?? 0;
  const high = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? high : (low + high) / 2;
}

export function classify(input: Input): Row[] {
  const start = Date.parse(`${input.from}T00:00:00Z`);
  const end = Date.parse(`${input.to}T00:00:00Z`) + 24 * hour;
  // The last disposition of a prompt wins.
  const latest = new Map<string, Disposition>();
  for (const disposition of input.dispositions)
    latest.set(disposition.hash, disposition);
  const rows: Row[] = [];
  for (const entry of input.entries) {
    const at = Date.parse(entry.time);
    if (!(at >= start && at < end)) continue;
    const disposition = latest.get(entry.hash);
    const linked = [
      ...new Set(
        [...(disposition?.ref ?? '').matchAll(taskId)]
          .map((match) => match[0])
          .filter((id) => input.tasks.has(id)),
      ),
    ];
    let group: Group;
    if (isHarnessText(entry.text)) group = 'harness';
    else if (launcherText.test(entry.text.trimStart())) group = 'automation';
    else if (disposition === undefined) group = 'undisposed';
    else if (
      disposition.kind === 'answered' &&
      automationRef.test(disposition.ref)
    )
      group = 'automation';
    else if (linked.length > 0) group = 'task';
    else group = disposition.kind === 'memory' ? 'memory' : 'chat';
    const states = linked.map((id) => input.tasks.get(id));
    const anyOpen = states.some((state) => state?.open === true);
    // The first merge naming a linked task at or after the prompt.
    const merged = linked
      .flatMap((id) => input.merges.get(id) ?? [])
      .filter((time) => time >= at);
    const first = merged.length === 0 ? undefined : Math.min(...merged);
    rows.push({
      hash: entry.hash,
      time: entry.time,
      text: oneLine(entry.text, 70),
      group,
      tasks: linked,
      allDone: linked.length > 0 && states.every((state) => state?.done),
      anyOpen,
      openAfterDay: anyOpen && input.now - at > 24 * hour,
      ...(first === undefined ? {} : { mergeHours: (first - at) / hour }),
    });
  }
  return rows;
}

const percent = (part: number, whole: number): string =>
  whole === 0
    ? 'n/a'
    : `${((100 * part) / whole).toFixed(0)}% (${part}/${whole})`;

export function summary(rows: Row[]): string {
  const count = (group: Group) =>
    rows.filter((row) => row.group === group).length;
  const operator = rows.filter(
    (row) => row.group !== 'harness' && row.group !== 'automation',
  );
  const withTask = operator.filter((row) => row.tasks.length > 0);
  const done = withTask.filter((row) => row.allDone);
  const hours = withTask.flatMap((row) => row.mergeHours ?? []);
  const middle = median(hours);
  const stale = withTask.filter((row) => row.openAfterDay);
  const lines = [
    `rows in window: ${rows.length} (harness ${count('harness')}, automation ${count('automation')}, operator ${operator.length})`,
    `operator rows by disposition: task ${count('task')}, memory ${count('memory')}, chat ${count('chat')}, undisposed ${count('undisposed')}`,
    `share with a task: ${percent(withTask.length, operator.length)}`,
    `share closed done (of rows with a task): ${percent(done.length, withTask.length)}`,
    `share still open after a day (of rows with a task): ${percent(stale.length, withTask.length)}`,
    `prompt-to-merge, first closing merge after the prompt: median ${middle === undefined ? 'n/a' : `${middle.toFixed(1)} h`} over ${hours.length} rows`,
  ];
  return `${lines.join('\n')}\n`;
}

export function table(rows: Row[]): string {
  const lines = ['time\tgroup\ttasks\tdone\tmerge_h\ttext'];
  for (const row of rows)
    lines.push(
      [
        row.time.slice(0, 16),
        row.group,
        row.tasks.join(','),
        row.tasks.length === 0
          ? ''
          : row.allDone
            ? 'done'
            : row.anyOpen
              ? 'open'
              : 'other',
        row.mergeHours === undefined ? '' : row.mergeHours.toFixed(1),
        row.text,
      ].join('\t'),
    );
  return `${lines.join('\n')}\n`;
}

function jsonLines<T>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* a torn last line must not hide the rest */
    }
  }
  return out;
}

function readTasks(root: string): Map<string, TaskState> {
  const directory = join(root, 'tasks');
  const tasks = new Map<string, TaskState>();
  for (const name of readdirSync(directory)) {
    if (!/^t-[a-z0-9]{7}\.json$/u.test(name)) continue;
    try {
      const task = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      tasks.set(name.slice(0, -'.json'.length), {
        open: task.status === 'open',
        done: task.status === 'closed' && task.resolution?.kind === 'done',
      });
    } catch {
      /* an unreadable record is not a task */
    }
  }
  return tasks;
}

function readMerges(root: string): Map<string, number[]> {
  const log = spawnSync(
    'git',
    ['-C', root, 'log', 'origin/main', '--format=%ct%x1f%B%x1e'],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  const merges = new Map<string, number[]>();
  if (log.status !== 0) return merges;
  for (const record of log.stdout.split('\x1e')) {
    const [seconds, body = ''] = record.split('\x1f');
    const at = Number(seconds) * 1000;
    if (!Number.isFinite(at)) continue;
    for (const line of body.split('\n')) {
      const match = /^Ticket:\s*(.+)$/u.exec(line.trim());
      for (const id of match?.[1]?.match(taskId) ?? []) {
        merges.set(id, [...(merges.get(id) ?? []), at]);
      }
    }
  }
  return merges;
}

function main(argv: string[]): void {
  let from: string | undefined;
  let to: string | undefined;
  let root = process.cwd();
  let rows = false;
  const queue = [...argv];
  for (let a = queue.shift(); a !== undefined; a = queue.shift()) {
    if (a === '--from') from = queue.shift();
    else if (a === '--to') to = queue.shift();
    else if (a === '--root') root = resolve(queue.shift() ?? '.');
    else if (a === '--rows') rows = true;
    else {
      process.stderr.write(`${usage}\n`);
      process.exit(64);
    }
  }
  const date = /^\d{4}-\d{2}-\d{2}$/u;
  if (!from || !to || !date.test(from) || !date.test(to)) {
    process.stderr.write(`${usage}\n`);
    process.exit(64);
  }
  const operator = join(inboxRoot(root), '.krn/operator');
  const result = classify({
    entries: jsonLines<InboxEntry>(join(operator, 'inbox.jsonl')),
    dispositions: jsonLines<Disposition>(join(operator, 'dispositions.jsonl')),
    tasks: readTasks(root),
    merges: readMerges(root),
    from,
    to,
    now: Date.now(),
  });
  process.stdout.write(`${rows ? table(result) : ''}${summary(result)}`);
}

if (import.meta.main) main(process.argv.slice(2));
