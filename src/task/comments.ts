import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type TaskId, TaskUsageError } from './record.ts';

/**
 * Comments live beside a task in tasks/<id>.comments.jsonl, one JSON object
 * per line, append-only. .gitattributes marks the file merge=union so two
 * branches that each append a comment merge by keeping both lines.
 */
export interface TaskComment {
  actor: string;
  at: string;
  text: string;
}

const commentKeys = ['actor', 'at', 'text'] as const;
const commentFilePattern = /^(.+)\.comments\.jsonl$/u;

export function commentsPath(root: string, id: TaskId): string {
  return join(root, 'tasks', `${id}.comments.jsonl`);
}

export function commentFileTaskId(name: string): string | undefined {
  return commentFilePattern.exec(name)?.[1];
}

export function gitActor(root: string): string | undefined {
  const result = spawnSync('git', ['-C', root, 'config', 'user.name'], {
    encoding: 'utf8',
  });
  const name = result.status === 0 ? result.stdout.trim() : '';
  return name === '' ? undefined : name;
}

export function appendComment(
  root: string,
  id: TaskId,
  input: { actor: string; text: string; at?: string },
): TaskComment {
  const actor = input.actor.trim();
  const text = input.text.replace(/\r\n?/gu, '\n').trim();
  if (actor === '' || /[\r\n]/u.test(actor))
    throw new TaskUsageError('comment actor must be a non-empty single line');
  if (text === '') throw new TaskUsageError('comment body must not be empty');
  const comment: TaskComment = {
    actor,
    at: input.at ?? new Date().toISOString(),
    text,
  };
  const path = commentsPath(root, id);
  // Repair a missing final newline so the new entry never fuses with the last.
  const prefix =
    existsSync(path) &&
    statSync(path).size > 0 &&
    !readFileSync(path, 'utf8').endsWith('\n')
      ? '\n'
      : '';
  appendFileSync(path, `${prefix}${JSON.stringify(comment)}\n`);
  return comment;
}

/** Stable by time, so a union-merged file reads chronologically. */
export function readComments(root: string, id: TaskId): TaskComment[] {
  const path = commentsPath(root, id);
  if (!existsSync(path)) return [];
  const parsed = parseComments(readFileSync(path));
  return parsed.comments;
}

export function parseComments(contents: Buffer | string): {
  comments: TaskComment[];
  findings: string[];
} {
  const findings: string[] = [];
  let text: string;
  try {
    text =
      typeof contents === 'string'
        ? contents
        : new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch {
    return { comments: [], findings: ['file is not valid UTF-8'] };
  }
  if (text.includes('\r')) findings.push('contains CR characters');
  if (text !== '' && !text.endsWith('\n'))
    findings.push('missing trailing newline');
  const comments: TaskComment[] = [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const [index, line] of lines.entries()) {
    const label = `line ${index + 1}`;
    if (/^(?:<{7,}|={7,}|>{7,})(?: |$)/u.test(line)) {
      findings.push(`${label}: Git conflict marker`);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      findings.push(`${label}: invalid JSON`);
      continue;
    }
    const comment = checkComment(value, label, findings);
    if (comment !== undefined) comments.push(comment);
  }
  comments.sort((left, right) =>
    left.at < right.at ? -1 : left.at > right.at ? 1 : 0,
  );
  return { comments, findings };
}

function checkComment(
  value: unknown,
  label: string,
  findings: string[],
): TaskComment | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.push(`${label}: comment must be a JSON object`);
    return undefined;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (
    keys.length !== commentKeys.length ||
    keys.some((key, i) => key !== commentKeys[i])
  ) {
    findings.push(`${label}: comment keys must be actor, at, text in order`);
    return undefined;
  }
  const { actor, at, text } = object;
  if (
    typeof actor !== 'string' ||
    actor.trim() === '' ||
    /[\r\n]/u.test(actor)
  ) {
    findings.push(`${label}: "actor" must be a non-empty single line`);
    return undefined;
  }
  if (
    typeof at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(at) ||
    Number.isNaN(Date.parse(at))
  ) {
    findings.push(`${label}: "at" must be an ISO UTC timestamp`);
    return undefined;
  }
  if (typeof text !== 'string' || text.trim() === '') {
    findings.push(`${label}: "text" must be a non-empty string`);
    return undefined;
  }
  return { actor, at, text };
}
