// Writers for the capsule and handoff: `krn state set|accept|handoff` produce
// exactly what `krn state check` and handoff-requests accept, so nobody
// hand-edits the field lines or the bracketed acceptance ledger again.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ABI_LABELS,
  type AbiLabel,
  type AcceptanceItem,
  FIXED_POINT_LABEL,
  hasFixedPointAnchor,
  OUTCOME_STATES,
  PUBLICATION_STATES,
  parseAcceptance,
  parseCleanup,
} from './capsule.ts';
import { git } from './git.ts';
import { resolveRepositoryRoot } from './runs.ts';

/** Capsules are replaced whole: a crash leaves the old file, never a torn one. */
function writeCapsuleFile(file: string, text: string): void {
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, file);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

export function capsuleDirectory(repo: string, id?: string): string {
  const { root } = resolveRepositoryRoot(repo);
  const base = join(root, '.krn', 'runs', 'delivery-loop');
  const ids = existsSync(base)
    ? readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
    : [];
  const chosen = id ?? (ids.length === 1 ? ids[0] : undefined);
  if (!chosen || !ids.includes(chosen))
    throw new Error(
      id
        ? `no capsule ${id} under .krn/runs/delivery-loop`
        : `pass --capsule <id>; capsules: ${ids.join(', ') || 'none'}`,
    );
  return join(base, chosen);
}

function resolveLabel(name: string): AbiLabel {
  const wanted = name.trim().toLowerCase();
  const labels = ABI_LABELS.map(
    (label) => [label, label.toLowerCase()] as const,
  );
  const exact = labels.filter(([, lower]) => lower === wanted);
  const pick = (matches: typeof labels) =>
    matches.length === 1 ? (matches[0]?.[0] as AbiLabel) : undefined;
  const found =
    pick(exact) ??
    pick(labels.filter(([, lower]) => lower.startsWith(wanted))) ??
    pick(labels.filter(([, lower]) => lower.includes(wanted)));
  if (!found || wanted === '')
    throw new Error(
      `field "${name}" does not name exactly one capsule field; fields: ${ABI_LABELS.join(' | ')}`,
    );
  return found;
}

// A value the check would reject is refused here, before it reaches the file.
function validateValue(label: AbiLabel, value: string): void {
  if (label === 'Outcome state' && !OUTCOME_STATES.has(value))
    throw new Error(
      `Outcome state must be one of ${[...OUTCOME_STATES].join(', ')}`,
    );
  if (label === 'Publication state' && !PUBLICATION_STATES.has(value))
    throw new Error(
      `Publication state must be one of ${[...PUBLICATION_STATES].join(', ')}`,
    );
  if (label === 'Outcome and observable acceptance') {
    const { malformed } = parseAcceptance(value);
    if (malformed.length > 0)
      throw new Error(
        `acceptance entries must read [criterion; todo|pass|drop:<why>] with no comma inside an entry: ${malformed.join(' | ')}; use \`krn state accept\``,
      );
  }
  if (label === FIXED_POINT_LABEL && !hasFixedPointAnchor(value))
    throw new Error(
      `fixed point needs an anchor such as HEAD=<sha> or base=<sha> (or fingerprint=<value>): ${value}`,
    );
  if (label === 'Outstanding workflow-run cleanup') {
    const { malformed } = parseCleanup(value);
    if (malformed.length > 0)
      throw new Error(
        `cleanup must be none or [pointer; workflow; consumer; trigger; ACTIVE|CLEANUP_PENDING|BLOCKED]: ${malformed.join(' | ')}`,
      );
  }
}

function setLine(text: string, label: string, value: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex((line) =>
    line.trimStart().startsWith(`${label}:`),
  );
  const next = `${label}: ${value}`;
  if (index === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(next, '');
  } else lines[index] = next;
  return lines.join('\n');
}

export function setFields(
  directory: string,
  pairs: [string, string][],
): AbiLabel[] {
  const file = join(directory, 'state.md');
  let text = readFileSync(file, 'utf8');
  const changed: AbiLabel[] = [];
  for (const [name, raw] of pairs) {
    const label = resolveLabel(name);
    const value = oneLine(raw);
    validateValue(label, value);
    text = setLine(text, label, value);
    changed.push(label);
  }
  writeCapsuleFile(file, text);
  return changed;
}

// Entries are split on commas and semicolons, so neither may appear in text.
const clean = (value: string) =>
  oneLine(value.replace(/[,;]/g, ' ').replace(/[<>[\]]/g, ''));

export function acceptCriterion(
  directory: string,
  criterionText: string,
  statusText: string,
): AcceptanceItem[] {
  const label = 'Outcome and observable acceptance';
  const criterion = clean(criterionText);
  const rawStatus = oneLine(statusText);
  const drop = /^drop\s*:\s*(.*)$/i.exec(rawStatus);
  let item: AcceptanceItem;
  if (drop) {
    const reason = clean(drop[1] ?? '');
    if (!reason) throw new Error('drop needs a reason: drop:<why>');
    item = { criterion, status: 'drop', reason };
  } else if (rawStatus === 'todo' || rawStatus === 'pass')
    item = { criterion, status: rawStatus };
  else throw new Error('status must be todo, pass or drop:<why>');
  if (!criterion) throw new Error('criterion is empty');
  const file = join(directory, 'state.md');
  const text = readFileSync(file, 'utf8');
  const current = text
    .split('\n')
    .find((line) => line.trimStart().startsWith(`${label}:`))
    ?.trimStart()
    .slice(label.length + 1);
  const parsed = parseAcceptance(current ?? '');
  if (parsed.malformed.length > 0)
    throw new Error(
      `existing ledger is malformed (${parsed.malformed.join(' | ')}); fix it with \`krn state set acceptance "[...]"\``,
    );
  const items = [...parsed.items];
  const at = items.findIndex((entry) => entry.criterion === criterion);
  if (at === -1) items.push(item);
  else items[at] = item;
  const ledger = `[${items
    .map(
      (entry) =>
        `${entry.criterion}; ${entry.status === 'drop' ? `drop:${entry.reason}` : entry.status}`,
    )
    .join(', ')}]`;
  writeCapsuleFile(file, setLine(text, label, ledger));
  return items;
}

interface HandoffOptions {
  task?: string | undefined;
  sha?: string | undefined;
  verify?: string | undefined;
  roadmap?: string | undefined;
  requests: string[];
  priorities: string[];
}

function replaceSection(text: string, title: string, body: string): string {
  const lines = text.split('\n');
  let start = -1;
  let end = lines.length;
  let fence = false;
  for (const [index, line] of lines.entries()) {
    if (/^ {0,3}(`{3,}|~{3,})/u.test(line)) fence = !fence;
    const heading = fence
      ? null
      : /^ {0,3}(#{1,2})[ \t]+(.*?)[ \t#]*$/u.exec(line);
    if (!heading) continue;
    if (start !== -1) {
      end = index;
      break;
    }
    if (
      heading[1] === '##' &&
      heading[2]?.toLowerCase() === title.toLowerCase()
    )
      start = index;
  }
  const block = [`## ${title}`, ...body.split('\n'), ''];
  if (start === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return `${[...lines, '', ...block].join('\n')}`;
  }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
}

const MERGED_LIMIT = 20;

// The first-parent commits between the previous handoff's first Resume SHA and
// HEAD, one bullet each; undefined when there is no previous SHA to diff from.
function mergedSincePrevious(root: string, text: string): string | undefined {
  const shas = text.split('\n').find((line) => line.startsWith('- SHAs:'));
  const previous = /\b[0-9a-f]{7,40}\b/.exec(shas ?? '')?.[0];
  if (!previous) return undefined;
  if (!git(root, ['merge-base', '--is-ancestor', previous, 'HEAD']).ok)
    return undefined;
  const log = git(root, [
    'log',
    '--first-parent',
    '--format=%h %s',
    `${previous}..HEAD`,
  ]);
  if (!log.ok) return undefined;
  const lines = log.out.split('\n').filter(Boolean);
  if (lines.length === 0) return `- none since ${previous}`;
  const shown = lines
    .slice(0, MERGED_LIMIT)
    .map(
      (line) =>
        `- ${oneLine(line).replace(/operator\s+requests/gi, 'operator asks')}`,
    );
  if (lines.length > MERGED_LIMIT)
    shown.push(
      `- ${lines.length - MERGED_LIMIT} more: git log --first-parent ${previous}..HEAD`,
    );
  return shown.join('\n');
}

export function writeHandoff(
  repo: string,
  directory: string,
  options: HandoffOptions,
): string {
  const { root } = resolveRepositoryRoot(repo);
  const capsule = readFileSync(join(directory, 'state.md'), 'utf8');
  const next = capsule
    .split('\n')
    .find((line) => line.startsWith('Next bounded owner and action:'));
  const task = options.task ?? /\bt-[a-z0-9]{7}\b/.exec(next ?? '')?.[0];
  if (!task)
    throw new Error('pass --task <id>; the next action names no task id');
  if (!/^t-[a-z0-9]{7}$/.test(task)) throw new Error(`bad task id ${task}`);
  const head = git(root, ['rev-parse', 'HEAD']);
  const sha = options.sha ?? (head.ok ? `HEAD ${head.out}` : undefined);
  if (!sha || !/\b[0-9a-f]{7,40}\b/.test(sha))
    throw new Error('pass --sha with at least one commit SHA');
  const verify = (options.verify ?? 'krn state check --root .').replace(
    /`/g,
    '',
  );
  const roadmap = options.roadmap ?? 'unchanged (no roadmap edit this session)';
  for (const request of options.requests)
    if (/operator\s+requests/i.test(request))
      throw new Error(
        'a request may not contain the phrase "operator requests"',
      );
  const resume = [
    `- Task: ${task}`,
    `- SHAs: ${oneLine(sha)}`,
    `- Verify: \`${oneLine(verify)}\``,
    `- Roadmap: ${oneLine(roadmap)}`,
  ].join('\n');
  const file = join(directory, 'handoff.md');
  const name = directory.split('/').pop();
  let text = existsSync(file)
    ? readFileSync(file, 'utf8')
    : `# Handoff — ${name}\n`;
  const fresh = !existsSync(file);
  const merged = mergedSincePrevious(root, text);
  text = replaceSection(text, 'Resume', resume);
  if (merged !== undefined) text = replaceSection(text, 'Merged', merged);
  if (options.priorities.length > 0)
    text = replaceSection(
      text,
      'Priorities',
      options.priorities
        .map((entry, index) => `${index + 1}. ${oneLine(entry)}`)
        .join('\n'),
    );
  if (options.requests.length > 0)
    text = replaceSection(
      text,
      'Operator requests',
      options.requests
        .map((entry) => `- ${oneLine(entry).replace(/^[-*+]\s+/, '')}`)
        .join('\n'),
    );
  else if (fresh) text = replaceSection(text, 'Operator requests', '- none');
  writeCapsuleFile(file, text);
  return file;
}
