import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseTaskDocument,
  serializeTask,
  type TaskId,
  type TaskRecord,
} from './record.ts';
import { atomicWrite } from './staged-write.ts';

/** Directory under `tasks/` that holds closed tasks, one `<YYYY-MM>.jsonl` per created month. */
export const ARCHIVE_DIR = 'archive';

/** A task is archived once it has been closed for this many days (the age is measured from `created`). */
export const ARCHIVE_AFTER_DAYS = 14;

const DAY_MS = 86_400_000;

export interface ArchivedLine {
  path: string;
  record: TaskRecord | undefined;
  findings: string[];
  id: string | undefined;
  after: string[];
  resolutionRef: string | undefined;
}

/** The repo-relative archive file that holds a task created in `created`. */
export function archiveFile(created: string): string {
  return `tasks/${ARCHIVE_DIR}/${created.slice(0, 7)}.jsonl`;
}

/** Archive file names under `tasks/archive`, sorted. */
function archiveNames(root: string): string[] {
  const directory = join(root, 'tasks', ARCHIVE_DIR);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort();
}

/** A JSONL line as the pretty document the record parser expects; text that is not JSON is passed through so the parser reports it. */
function expand(line: string): string {
  try {
    return `${JSON.stringify(JSON.parse(line), null, 2)}\n`;
  } catch {
    return `${line}\n`;
  }
}

function lineOf(record: TaskRecord): string {
  return JSON.stringify(JSON.parse(serializeTask(record)));
}

/** Every archived record, parsed and validated line by line. */
export function readArchive(root: string): ArchivedLine[] {
  const lines: ArchivedLine[] = [];
  for (const name of archiveNames(root)) {
    const path = `tasks/${ARCHIVE_DIR}/${name}`;
    if (!name.endsWith('.jsonl')) {
      lines.push({
        path,
        record: undefined,
        findings: [`${path}: non-JSONL file in task archive`],
        id: undefined,
        after: [],
        resolutionRef: undefined,
      });
      continue;
    }
    const text = readFileSync(join(root, path), 'utf8');
    for (const [number, line] of text.split('\n').entries()) {
      if (line === '') continue;
      const where = `${path}:${number + 1}`;
      const parsed = parseTaskDocument(expand(line));
      const findings = parsed.findings.map((finding) => `${where}: ${finding}`);
      if (parsed.record !== undefined && lineOf(parsed.record) !== line)
        findings.push(`${where}: line is not the canonical compact record`);
      if (parsed.record !== undefined && parsed.record.status !== 'closed')
        findings.push(`${where}: archived tasks must be closed`);
      if (
        parsed.record !== undefined &&
        archiveFile(parsed.record.created) !== path
      )
        findings.push(
          `${where}: task belongs in ${archiveFile(parsed.record.created)}`,
        );
      lines.push({
        path: where,
        record: parsed.record,
        findings,
        id: parsed.id,
        after: parsed.afterReferences,
        resolutionRef: parsed.resolutionReference,
      });
    }
  }
  return lines;
}

/** One archived record by id, or undefined. Only files whose text names the id are parsed. */
export function findArchived(root: string, id: TaskId): TaskRecord | undefined {
  for (const name of archiveNames(root)) {
    if (!name.endsWith('.jsonl')) continue;
    const text = readFileSync(join(root, 'tasks', ARCHIVE_DIR, name), 'utf8');
    if (!text.includes(`"id":${JSON.stringify(id)}`)) continue;
    for (const line of text.split('\n')) {
      if (!line.includes(`"id":${JSON.stringify(id)}`)) continue;
      const parsed = parseTaskDocument(expand(line));
      if (parsed.record?.id === id) return parsed.record;
    }
  }
  return undefined;
}

export interface ArchiveResult {
  archived: TaskId[];
  files: string[];
}

/**
 * Moves closed tasks created at least `olderThanDays` before `today` from
 * `tasks/<id>.json` into `tasks/archive/<YYYY-MM>.jsonl`. Placement and order
 * depend only on the records, so a second run writes identical bytes.
 */
export function archiveClosedTasks(
  root: string,
  records: Iterable<TaskRecord>,
  today: Date,
  olderThanDays = ARCHIVE_AFTER_DAYS,
): ArchiveResult {
  const cutoff = today.getTime() - olderThanDays * DAY_MS;
  const moving = [...records].filter(
    (record) =>
      record.status === 'closed' &&
      existsSync(join(root, 'tasks', `${record.id}.json`)) &&
      Date.parse(`${record.created}T00:00:00Z`) <= cutoff,
  );
  const byFile = new Map<string, TaskRecord[]>();
  for (const record of moving) {
    const file = archiveFile(record.created);
    byFile.set(file, [...(byFile.get(file) ?? []), record]);
  }
  const files: string[] = [];
  for (const [file, added] of [...byFile].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const existing = new Map<string, TaskRecord>();
    for (const line of readArchive(root))
      if (
        line.record !== undefined &&
        archiveFile(line.record.created) === file
      )
        existing.set(line.record.id, line.record);
    for (const record of added) existing.set(record.id, record);
    const text = [...existing.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((record) => `${lineOf(record)}\n`)
      .join('');
    atomicWrite(root, join(root, file), text, true);
    files.push(file);
  }
  // Files are deleted only after every archive file is on disk.
  for (const record of moving)
    unlinkSync(join(root, 'tasks', `${record.id}.json`));
  return { archived: moving.map((record) => record.id).sort(), files };
}
