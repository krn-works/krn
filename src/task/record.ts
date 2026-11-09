import { randomBytes } from 'node:crypto';

const taskKeys = [
  'id',
  'status',
  'resolution',
  'created',
  'priority',
  'title',
  'after',
  'body',
] as const;
// `acceptance` is optional and last; tasks without it keep their old bytes.
const acceptanceKey = 'acceptance';
const acceptanceKeys = ['verify', 'passes', 'exit'] as const;

const resolutionKeys = ['kind', 'ref', 'note'] as const;
const taskIdPattern = /^[A-Za-z]+-[0-9A-Za-z]+$/u;
// Ids name files (`tasks/<id>.json`, staged claim files), so they stay far
// below the 255-byte file-name limit; generated ids have 9 characters.
export const TASK_ID_MAX_LENGTH = 128;
const taskKinds = ['done', 'dropped', 'duplicate', 'superseded'] as const;
const crockford = '0123456789abcdefghjkmnpqrstvwxyz';

export type TaskId = string;
export type TaskStatus = 'open' | 'closed';
type TaskResolutionKind = (typeof taskKinds)[number];

export interface TaskResolution {
  kind: TaskResolutionKind;
  ref: TaskId | null;
  note: string;
}

export interface TaskAcceptance {
  verify: string;
  passes: boolean;
  exit: number | null;
}

export interface TaskRecord {
  id: TaskId;
  status: TaskStatus;
  resolution: TaskResolution | null;
  created: string;
  priority: number;
  title: string;
  after: TaskId[];
  body: string[];
  acceptance?: TaskAcceptance[];
}

interface ParsedTask {
  record?: TaskRecord;
  findings: string[];
  id: string | undefined;
  afterReferences: string[];
  resolutionReference: string | undefined;
}

export class TaskUsageError extends Error {
  readonly exitCode = 64;
}

export class TaskDataError extends Error {
  readonly exitCode = 65;
  readonly findings: string[];

  constructor(findings: string[]) {
    super(findings.join('\n'));
    this.findings = findings;
  }
}

export class TaskCommandError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function isTaskId(value: unknown): value is TaskId {
  return (
    typeof value === 'string' &&
    value.length <= TASK_ID_MAX_LENGTH &&
    taskIdPattern.test(value)
  );
}

export function createTaskId(): TaskId {
  let value = BigInt(`0x${randomBytesHex()}`) & ((1n << 35n) - 1n);
  const result = Array<string>(7);
  for (let index = result.length - 1; index >= 0; index -= 1) {
    result[index] = crockford[Number(value & 31n)] ?? '0';
    value >>= 5n;
  }
  return `t-${result.join('')}`;
}

function randomBytesHex(): string {
  // Kept in a tiny helper so record validation stays independent of the store.
  return randomBytes(5).toString('hex');
}

export function serializeTask(record: TaskRecord): string {
  const canonical: TaskRecord = {
    id: record.id,
    status: record.status,
    resolution:
      record.resolution === null
        ? null
        : {
            kind: record.resolution.kind,
            ref: record.resolution.ref,
            note: record.resolution.note,
          },
    created: record.created,
    priority: record.priority,
    title: record.title,
    after: [...new Set(record.after)].sort(),
    body: [...record.body],
    ...(record.acceptance === undefined || record.acceptance.length === 0
      ? {}
      : {
          acceptance: record.acceptance.map((entry) => ({
            verify: entry.verify,
            passes: entry.passes,
            exit: entry.exit,
          })),
        }),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function parseTaskDocument(contents: Buffer | string): ParsedTask {
  const findings: string[] = [];
  let text: string;
  try {
    text =
      typeof contents === 'string'
        ? contents
        : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            contents,
          );
  } catch {
    return {
      findings: ['file is not valid UTF-8'],
      id: undefined,
      afterReferences: [],
      resolutionReference: undefined,
    };
  }

  const hasBom = text.startsWith('\uFEFF');
  if (hasBom) findings.push('file starts with a byte order mark');

  if (/^(?:<{7,}|={7,}|>{7,}|\|{7,})(?: |$)/mu.test(text))
    findings.push('contains Git conflict markers');
  if (text.includes('\r'))
    findings.push('contains CR characters; tasks require LF');
  if (!text.endsWith('\n')) findings.push('missing trailing newline');

  let value: unknown;
  try {
    value = JSON.parse(hasBom ? text.slice(1) : text);
  } catch {
    findings.push('invalid JSON');
    return {
      findings,
      id: undefined,
      afterReferences: [],
      resolutionReference: undefined,
    };
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.push('record must be a JSON object');
    return {
      findings,
      id: undefined,
      afterReferences: [],
      resolutionReference: undefined,
    };
  }

  const object = value as Record<string, unknown>;
  const id = typeof object.id === 'string' ? object.id : undefined;
  const afterReferences = Array.isArray(object.after)
    ? object.after.filter(
        (reference): reference is string => typeof reference === 'string',
      )
    : [];
  const resolutionObject =
    object.resolution !== null &&
    typeof object.resolution === 'object' &&
    !Array.isArray(object.resolution)
      ? (object.resolution as Record<string, unknown>)
      : undefined;
  const resolutionReference =
    typeof resolutionObject?.ref === 'string'
      ? resolutionObject.ref
      : undefined;
  const actualKeys = Object.keys(object);
  for (const key of taskKeys) {
    if (!(key in object)) findings.push(`missing key "${key}"`);
  }
  const expectedKeys: readonly string[] =
    acceptanceKey in object ? [...taskKeys, acceptanceKey] : taskKeys;
  for (const key of actualKeys) {
    if (!expectedKeys.includes(key)) findings.push(`extra key "${key}"`);
  }
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  )
    findings.push('wrong top-level key order');

  if (id === undefined) findings.push('"id" must be a string');
  else if (!isTaskId(id)) findings.push('"id" is not a valid task id');

  let status: TaskStatus | undefined;
  if (object.status === 'open' || object.status === 'closed')
    status = object.status;
  else findings.push('"status" must be "open" or "closed"');

  const resolution = parseResolution(object.resolution, findings);

  const created =
    typeof object.created === 'string' ? object.created : undefined;
  if (created === undefined) findings.push('"created" must be a string');
  else if (!isDate(created))
    findings.push('"created" must be a real YYYY-MM-DD date');

  const priority = object.priority;
  if (typeof priority !== 'number' || !Number.isInteger(priority))
    findings.push('"priority" must be an integer');
  else if (priority < 0 || priority > 3)
    findings.push('"priority" must be between 0 and 3');

  const title = typeof object.title === 'string' ? object.title : undefined;
  if (title === undefined) findings.push('"title" must be a string');
  else if (title.trim().length === 0)
    findings.push('"title" must not be empty');
  else if (/[\r\n]/u.test(title))
    findings.push('"title" must be a single line');

  const after = parseStringArray(object.after, '"after"', findings, true);
  const body = parseStringArray(object.body, '"body"', findings, false);
  const acceptance =
    acceptanceKey in object
      ? parseAcceptance(object.acceptance, findings)
      : undefined;

  if (
    status === 'closed' &&
    resolution?.kind === 'done' &&
    acceptance?.some((entry) => !entry.passes)
  )
    findings.push('tasks closed as done require passing acceptance entries');
  if (
    status === 'open' &&
    object.resolution !== null &&
    object.resolution !== undefined
  )
    findings.push('open tasks must have a null resolution');
  if (status === 'closed' && object.resolution === null)
    findings.push('closed tasks require a resolution');
  if (resolution !== undefined && resolution !== null) {
    const needsRef =
      resolution.kind === 'duplicate' || resolution.kind === 'superseded';
    if (needsRef && resolution.ref === null)
      findings.push(`${resolution.kind} resolutions require a ref`);
    if (!needsRef && resolution.ref !== null)
      findings.push(`${resolution.kind} resolutions must have a null ref`);
    if (resolution.ref !== null && !isTaskId(resolution.ref))
      findings.push('resolution ref is not a valid task id');
  }
  if (after !== undefined) {
    for (const dependency of after) {
      if (!isTaskId(dependency))
        findings.push(`"after" contains invalid task id "${dependency}"`);
    }
    const sorted = [...after].sort();
    if (after.some((dependency, index) => dependency !== sorted[index]))
      findings.push('"after" must be sorted');
    if (new Set(after).size !== after.length)
      findings.push('"after" must not contain duplicates');
  }

  const record =
    id !== undefined &&
    status !== undefined &&
    resolution !== undefined &&
    created !== undefined &&
    typeof priority === 'number' &&
    title !== undefined &&
    after !== undefined &&
    body !== undefined
      ? {
          id,
          status,
          resolution,
          created,
          priority,
          title,
          after,
          body,
          ...(acceptance === undefined ? {} : { acceptance }),
        }
      : undefined;

  if (record !== undefined && serializeTask(record) !== text)
    findings.push('file does not use canonical task serialization');

  return record === undefined
    ? { findings, id, afterReferences, resolutionReference }
    : { record, findings, id, afterReferences, resolutionReference };
}

function parseAcceptance(
  value: unknown,
  findings: string[],
): TaskAcceptance[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    findings.push('"acceptance" must be a non-empty array');
    return undefined;
  }
  const result: TaskAcceptance[] = [];
  for (const [index, item] of value.entries()) {
    const label = `"acceptance"[${index}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      findings.push(`${label} must be an object`);
      continue;
    }
    const entry = item as Record<string, unknown>;
    const keys = Object.keys(entry);
    if (
      keys.length !== acceptanceKeys.length ||
      keys.some((key, position) => key !== acceptanceKeys[position])
    ) {
      findings.push(`${label} must have keys verify, passes, exit in order`);
      continue;
    }
    const { verify, passes, exit } = entry;
    if (typeof verify !== 'string' || verify.trim() === '') {
      findings.push(`${label} "verify" must be a non-empty string`);
      continue;
    }
    if (typeof passes !== 'boolean') {
      findings.push(`${label} "passes" must be a boolean`);
      continue;
    }
    if (exit !== null && !Number.isInteger(exit)) {
      findings.push(`${label} "exit" must be an integer or null`);
      continue;
    }
    if (passes && exit !== 0)
      findings.push(`${label} passes only with a recorded exit 0`);
    result.push({ verify, passes, exit: exit as number | null });
  }
  return result.length === value.length ? result : undefined;
}

function parseResolution(
  value: unknown,
  findings: string[],
): TaskResolution | null | undefined {
  if (value === null) return null;
  if (
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    findings.push('"resolution" must be null or an object');
    return undefined;
  }

  const object = value as Record<string, unknown>;
  const actualKeys = Object.keys(object);
  for (const key of resolutionKeys) {
    if (!(key in object)) findings.push(`resolution missing key "${key}"`);
  }
  for (const key of actualKeys) {
    if (!(resolutionKeys as readonly string[]).includes(key))
      findings.push(`resolution has extra key "${key}"`);
  }
  if (
    actualKeys.length !== resolutionKeys.length ||
    actualKeys.some((key, index) => key !== resolutionKeys[index])
  )
    findings.push('wrong resolution key order');

  const kind = taskKinds.includes(object.kind as TaskResolutionKind)
    ? (object.kind as TaskResolutionKind)
    : undefined;
  if (kind === undefined)
    findings.push(
      'resolution "kind" must be done, dropped, duplicate, or superseded',
    );

  const ref = object.ref;
  if (ref !== null && typeof ref !== 'string')
    findings.push('resolution "ref" must be a task id or null');
  const note = typeof object.note === 'string' ? object.note : undefined;
  if (note === undefined) findings.push('resolution "note" must be a string');

  return kind !== undefined &&
    (ref === null || typeof ref === 'string') &&
    note !== undefined
    ? { kind, ref, note }
    : undefined;
}

function parseStringArray(
  value: unknown,
  label: string,
  findings: string[],
  validateIds: boolean,
): string[] | undefined {
  if (!Array.isArray(value)) {
    findings.push(`${label} must be an array`);
    return undefined;
  }
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      findings.push(`${label}[${index}] must be a string`);
      continue;
    }
    if (validateIds && !isTaskId(item))
      findings.push(`${label}[${index}] is not a valid task id`);
    result.push(item);
  }
  return result.length === value.length ? result : undefined;
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
