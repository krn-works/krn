// The task-quality rules behind the `task-quality` standards: each reads `tasks/*.json` raw and names
// the tasks that break it. A record that does not parse is `krn task check`'s finding, not a rule's.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TASK_RULES = [
  'measurable-outcome',
  'named-proof',
  'named-files',
  'one-pr',
  'declared-dependencies',
  'close-evidence',
] as const;
export type TaskRule = (typeof TASK_RULES)[number];

/** Closed `done` tasks created from this day on carry evidence; older records predate the rule. */
const EVIDENCE_FROM = '2026-11-01';

interface Raw {
  readonly id: string;
  readonly status: string;
  readonly created: string;
  readonly after: readonly string[];
  readonly text: string;
  readonly acceptance: number;
  readonly resolution: { kind?: string; note?: string } | null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

function readTasks(root: string): Raw[] {
  const dir = join(root, 'tasks');
  if (!existsSync(dir)) return [];
  const tasks: Raw[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const t = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<
        string,
        unknown
      >;
      tasks.push({
        id: String(t.id ?? name),
        status: String(t.status ?? ''),
        created: String(t.created ?? ''),
        after: strings(t.after),
        text: strings(t.body).join('\n'),
        acceptance: Array.isArray(t.acceptance) ? t.acceptance.length : 0,
        resolution:
          typeof t.resolution === 'object' && t.resolution !== null
            ? (t.resolution as Raw['resolution'])
            : null,
      });
    } catch {
      // an unreadable record is `krn task check`'s finding
    }
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

/** The text after `Label:` on the first body line that starts with one of the labels. */
function labelled(text: string, labels: string): string | undefined {
  return new RegExp(`^[ \\t]*(?:${labels})[^:\\n]*:[ \\t]*(.*)$`, 'imu').exec(
    text,
  )?.[1];
}

const MEASURABLE =
  /\d|\bexit|\bzero\b|\bno(?:ne|t)?\b|\bevery\b|\beach\b|\ball\b|\bat (?:least|most)\b|\bpass|\bfail|\bgreen\b|\bred\b|\bprint|\breport|\bname[sd]?\b|\bsays?\b|\blist|\bmerged?\b|\bruns?\b|\bonly\b|[`"'=<>]/iu;

const TOP_DIRS =
  /^(?:src|test|tests|docs|scripts|evals|standards|tasks|\.krn|\.github|\.agents)\//u;

function pathLike(token: string): boolean {
  if (/^[\w@-]+\.[a-z]{1,5}$/iu.test(token)) return true;
  if (!/^\/?\.?[\w@-]+(?:\/[\w.@-]+)+\/?$/iu.test(token)) return false;
  return (
    /\.[a-z]{1,5}$/iu.test(token) ||
    token.endsWith('/') ||
    token.split('/').length > 2 ||
    TOP_DIRS.test(token)
  );
}

function namesPath(text: string): boolean {
  return text
    .split(/[\s`()[\],;]+/u)
    .map((token) => token.replace(/:\d+$|[.:]+$/u, ''))
    .some(pathLike);
}

const MANY_PRS =
  /\b(?:[2-9]|\d{2,})\s*(?:PRs|pull requests)\b|\b(?:several|many|multi)\b/iu;

function openFailure(
  rule: TaskRule,
  t: Raw,
  ids: ReadonlySet<string>,
): string[] {
  const outcome = labelled(t.text, 'Outcome|Acceptance|Done when|Done means');
  if (rule === 'measurable-outcome')
    return t.acceptance > 0 ||
      (outcome !== undefined && MEASURABLE.test(outcome))
      ? []
      : [
          `${t.id}: no measurable "Outcome:" (state a count, exit code, named output or pass/fail), or add krn task create --verify`,
        ];
  if (rule === 'named-proof') {
    const proof = labelled(t.text, 'Proof|Remedy') ?? '';
    return t.acceptance > 0 ||
      proof.trim().split(/\s+/u).filter(Boolean).length >= 3
      ? []
      : [`${t.id}: no "Proof:" line naming the evidence (3+ words)`];
  }
  if (rule === 'named-files')
    return labelled(t.text, 'Files|Scope')?.trim() || namesPath(t.text)
      ? []
      : [`${t.id}: names no file; add a "Files:" line`];
  if (rule === 'one-pr')
    return MANY_PRS.test(labelled(t.text, 'Size') ?? '') ||
      MANY_PRS.test(outcome ?? '')
      ? [`${t.id}: declares more than one PR; split it into one-PR tasks`]
      : [];
  if (rule === 'declared-dependencies') {
    const named = [
      ...t.text.matchAll(
        /^[ \t]*(?:After|Blocked by|Depends on)[^:\n]*:[ \t]*(.*)$/gimu,
      ),
    ].flatMap((m) => m[1]?.match(/\bt-[0-9a-z]{7}\b/gu) ?? []);
    return [
      ...[...new Set(named)]
        .filter((dep) => !t.after.includes(dep))
        .map(
          (dep) =>
            `${t.id}: body names ${dep} as a dependency but "after" omits it; run krn task edit`,
        ),
      ...t.after
        .filter((dep) => !ids.has(dep))
        .map((dep) => `${t.id}: "after" names unknown task ${dep}`),
    ];
  }
  return [];
}

function closeFailure(t: Raw): string[] {
  return t.status === 'closed' &&
    t.resolution?.kind === 'done' &&
    t.created >= EVIDENCE_FROM &&
    (t.resolution.note ?? '').trim().length < 10 &&
    t.acceptance === 0
    ? [
        `${t.id}: closed done without evidence; close with --note naming what was proved`,
      ]
    : [];
}

/** The failures of one task-quality rule in the repository at `root`; empty when none or no `tasks/`. */
export function taskQualityFailures(root: string, rule: TaskRule): string[] {
  const tasks = readTasks(root);
  if (rule === 'close-evidence') return tasks.flatMap(closeFailure);
  const ids = new Set(tasks.map((t) => t.id));
  return tasks
    .filter((t) => t.status === 'open')
    .flatMap((t) => openFailure(rule, t, ids));
}
