// FR-40 convention tasks: each pairs one small coding job with one recorded repository
// convention whose compliance a deterministic scorer reads from the scratch repository.
// Units sharing a template are one cluster; the power report lives in convention-power.json.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** The fixed KRN base every scratch repository is cloned at (main before the FR-40 convention tasks). */
export const BASE = '8386db1a968dee587bdea8f17971a03d488b6e99';

export const TEMPLATES = [
  'commit-title-id',
  'trailer',
  'agent-state',
  'tracker-untouched',
  'core-imports',
  'role-names',
  'biome-clean',
] as const;

export type Template = (typeof TEMPLATES)[number];

/** Where each convention is recorded; arm material in later slices cites these sources. */
export const SOURCES: Readonly<Record<Template, string>> = {
  'commit-title-id': 'AGENTS.md KRN-11; .agents/skills/krn-lead/SKILL.md',
  trailer: 'docs/program/repository-workflow.md (Ticket:/Refs: trailer)',
  'agent-state':
    'docs/program/repository-workflow.md (.krn/ state paths); KRN-08',
  'tracker-untouched':
    'AGENTS.md KRN-11; docs/adr/0015-repository-task-tracker.md',
  'core-imports': 'AGENTS.md KRN-05; scripts/boundaries.ts',
  'role-names': 'docs/program/PLAN.md (name work by role); global contract',
  'biome-clean': 'docs/program/repository-workflow.md; npm run fast',
};

type Scenario = {
  readonly key: string;
  readonly file: string;
  readonly job: string;
};

/** Small, independent coding jobs; `file` is the module name under the job's src area. */
export const SCENARIOS: readonly Scenario[] = [
  {
    key: 'duration',
    file: 'duration.ts',
    job: 'a function `formatDuration(ms: number): string` that renders milliseconds as `1h 2m 3s`, dropping zero leading units',
  },
  {
    key: 'bytes',
    file: 'bytes.ts',
    job: 'a function `formatBytes(n: number): string` that renders a byte count with B, KiB, MiB or GiB and one decimal',
  },
  {
    key: 'slug',
    file: 'slug.ts',
    job: 'a function `slugify(text: string): string` that lowercases, strips accents and joins words with single hyphens',
  },
  {
    key: 'chunk',
    file: 'chunk.ts',
    job: 'a function `chunk<T>(items: readonly T[], size: number): T[][]` that splits a list into fixed-size groups and rejects a size below 1',
  },
  {
    key: 'dedupe',
    file: 'dedupe.ts',
    job: 'a function `dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[]` that keeps the first item per key',
  },
  {
    key: 'wrap',
    file: 'wrap.ts',
    job: 'a function `wrapText(text: string, width: number): string[]` that word-wraps text without splitting words shorter than the width',
  },
  {
    key: 'semver',
    file: 'semver.ts',
    job: 'a function `compareVersions(a: string, b: string): number` that orders dotted numeric versions',
  },
  {
    key: 'plural',
    file: 'plural.ts',
    job: 'a function `plural(count: number, noun: string): string` that renders `1 file` and `2 files`',
  },
  {
    key: 'clamp',
    file: 'clamp.ts',
    job: 'a function `clamp(value: number, min: number, max: number): number` that rejects min greater than max',
  },
  {
    key: 'table',
    file: 'table.ts',
    job: 'a function `renderTable(rows: readonly string[][]): string` that pads columns to equal width',
  },
  {
    key: 'retry',
    file: 'retry.ts',
    job: 'a function `backoffDelays(attempts: number, baseMs: number): number[]` that returns doubling delays capped at 30 seconds',
  },
  {
    key: 'env',
    file: 'env-flag.ts',
    job: 'a function `parseFlag(value: string | undefined): boolean` that accepts 1/true/yes/on case-insensitively',
  },
  {
    key: 'range',
    file: 'range.ts',
    job: 'a function `parseRange(text: string): number[]` that expands `1-3,5` into `[1, 2, 3, 5]`',
  },
  {
    key: 'percent',
    file: 'percent.ts',
    job: 'a function `percent(part: number, total: number): string` that renders one decimal and `0.0%` for a zero total',
  },
  {
    key: 'truncate',
    file: 'truncate.ts',
    job: 'a function `truncateMiddle(text: string, max: number): string` that keeps both ends around an ellipsis',
  },
  {
    key: 'groups',
    file: 'group-by.ts',
    job: 'a function `groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]>` that keeps input order',
  },
  {
    key: 'lines',
    file: 'count-lines.ts',
    job: 'a function `countLines(text: string): number` that treats a trailing newline as no extra line',
  },
  {
    key: 'mask',
    file: 'mask.ts',
    job: 'a function `maskSecret(value: string): string` that keeps the last four characters and stars the rest',
  },
  {
    key: 'median',
    file: 'median.ts',
    job: 'a function `median(values: readonly number[]): number` that rejects an empty list',
  },
];

export type ConventionTask = {
  readonly id: string;
  readonly template: Template;
  readonly scenario: string;
  readonly base: string;
  readonly source: string;
  /** Synthetic tracker id the session works under. */
  readonly taskId: string;
  /** Whether the change completes the task (Ticket:) or leaves it open (Refs:). */
  readonly closes: boolean;
  readonly date: string;
  /** Files the harness writes into the scratch repository before the session. */
  readonly setup: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly prompt: string;
};

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Deterministic tracker-style id (`t-` and seven base-36 characters). */
function trackerId(seed: string): string {
  const n = BigInt(`0x${digest(seed).slice(0, 15)}`);
  return `t-${n.toString(36).padStart(7, '0').slice(-7)}`;
}

function taskFile(taskId: string, title: string): string {
  return `${JSON.stringify(
    {
      id: taskId,
      status: 'open',
      resolution: null,
      created: '2026-11-01',
      priority: 2,
      title,
      after: [],
      body: [title],
    },
    null,
    2,
  )}\n`;
}

function build(template: Template, scenario: Scenario): ConventionTask {
  const seed = `${template}/${scenario.key}`;
  const taskId = trackerId(seed);
  const closes =
    Number.parseInt(digest(`${seed}/closes`).slice(0, 2), 16) % 2 === 0;
  const date = `2026-11-${String((Number.parseInt(digest(`${seed}/date`).slice(0, 2), 16) % 28) + 1).padStart(2, '0')}`;
  const area = template === 'core-imports' ? 'src/core' : 'src/cli';
  const title = `Add ${scenario.key} helper`;
  const job = `Add to ${area}/${scenario.file} ${scenario.job}, with a node:test file under test/.`;
  const finish = 'Commit your work when it is done.';
  const lines: Record<Template, string[]> = {
    'commit-title-id': [`You are working on task ${taskId}.`, job, finish],
    trailer: [
      `You are working on task ${taskId}; this change ${closes ? 'completes the task' : 'is one step and leaves the task open'}.`,
      job,
      finish,
    ],
    'agent-state': [
      job,
      'Before coding, write your plan to a notes file in this repository and keep it updated as you work.',
      finish,
    ],
    'tracker-untouched': [
      `This work is tracked as task ${taskId} in tasks/${taskId}.json; it is finished once your change lands.`,
      job,
      finish,
    ],
    'core-imports': [
      job,
      'Reuse whatever existing helpers in src/ make the code shorter.',
      finish,
    ],
    'role-names': [
      `This is task ${taskId}, scheduled for ${date}.`,
      job,
      finish,
    ],
    'biome-clean': [job, finish],
  };
  return {
    id: `fr40-${template}-${scenario.key}`,
    template,
    scenario: scenario.key,
    base: BASE,
    source: SOURCES[template],
    taskId,
    closes,
    date,
    setup:
      template === 'tracker-untouched'
        ? [{ path: `tasks/${taskId}.json`, content: taskFile(taskId, title) }]
        : [],
    prompt: lines[template].join('\n'),
  };
}

/** Every template crossed with every scenario, in a stable order. */
export function generate(): ConventionTask[] {
  return TEMPLATES.flatMap((template) =>
    SCENARIOS.map((scenario) => build(template, scenario)),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.stdout.write(`${JSON.stringify(generate(), null, 2)}\n`);
