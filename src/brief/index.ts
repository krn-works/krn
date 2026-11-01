import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Read a regular file reached without symlinks, refusing more than limit bytes. */
export function readRegularFile(
  path: string,
  limit: number,
  label: string,
): string {
  // Open the resolved path, so `link/..` cannot leave the checked parent.
  const full = resolve(path);
  const parent = dirname(full);
  if (realpathSync(parent) !== parent)
    throw new Error(`${label} path must not pass through a symlink`);
  if (!lstatSync(full).isFile())
    throw new Error(`${label} must be a regular non-symlink file`);
  const fd = openSync(
    full,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    if (stat.size > limit) throw new Error(`${label} exceeds ${limit} bytes`);
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > limit) throw new Error(`${label} exceeds ${limit} bytes`);
    const contents = bytes.subarray(0, size);
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        contents,
      );
      const hasBom =
        contents[0] === 0xef && contents[1] === 0xbb && contents[2] === 0xbf;
      return hasBom ? `\uFEFF${decoded}` : decoded;
    } catch {
      throw new Error(`${label} must be UTF-8 text`);
    }
  } finally {
    closeSync(fd);
  }
}

/** Only lines outside fences and HTML comments participate in Markdown grammar. */
function* outsideFences(text: string) {
  let fence: { marker: string; length: number } | undefined;
  let comment = false;
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (
        marker?.[1]?.startsWith(fence.marker) &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = undefined;
      continue;
    }
    if (comment) {
      if (line.includes('-->')) comment = false;
      continue;
    }
    if (/^ {0,3}<!--/u.test(line)) {
      if (!line.includes('-->')) comment = true;
      continue;
    }
    if (
      marker?.[1] &&
      (!marker[1].startsWith('`') || !marker[2]?.includes('`'))
    ) {
      fence = { marker: marker[1][0] ?? '', length: marker[1].length };
      continue;
    }
    yield { line, number: index + 1 };
  }
}

function checkText(brief: string, checklist: string): string[] {
  const ids = new Set<string>();
  for (const { line, number } of outsideFences(checklist)) {
    if (!/^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[\t ]|$)/u.test(line)) continue;
    const id = /^ {0,3}- `([^\s`:\p{Cc}]+)`:[\t ]*\S/u.exec(line)?.[1];
    if (id === undefined) return [`malformed checklist item at line ${number}`];
    if (ids.has(id)) return [`duplicate checklist id ${shortId(id)}`];
    ids.add(id);
    if (ids.size > 64) return ['checklist exceeds 64 ids'];
  }
  if (ids.size === 0) return ['checklist has no ids'];
  const reasons: string[] = [];
  const add = (reason: string) => {
    if (reasons.length < 64) reasons.push(reason);
  };
  const answered = new Set<string>();
  let found = false;
  let inside = false;
  const lines = Array.from(outsideFences(brief));
  const heading = (level: number, text: string, number: number) => {
    if (level > 2) return;
    inside = false;
    if (level !== 2 || text !== 'Hardening') return;
    if (found) add(`duplicate Hardening section at line ${number}`);
    else {
      found = true;
      inside = true;
    }
  };
  for (let index = 0; index < lines.length; index++) {
    const current = lines[index];
    if (!current) continue;
    const { line, number } = current;
    const next = lines[index + 1];
    if (
      next?.number === number + 1 &&
      isParagraphText(line) &&
      /^ {0,3}(?:=+|-+)[\t ]*$/u.test(next.line)
    ) {
      // A setext heading takes its whole paragraph as its text.
      const previous = lines[index - 1];
      const single =
        previous?.number !== number - 1 || !isParagraphText(previous.line);
      heading(
        next.line.trim().startsWith('=') ? 1 : 2,
        single ? line.trim() : '',
        number,
      );
      index++;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[\t ]+(.*))?$/u.exec(line);
    const level = atx?.[1]?.length;
    if (level !== undefined) {
      heading(
        level,
        (atx?.[2] ?? '')
          .trimEnd()
          .replace(/(?:^|[\t ])#+$/u, '')
          .trim(),
        number,
      );
      if (level <= 2) continue;
    }
    if (!inside) continue;
    const answer =
      /^ {0,1}[-*][\t ]+(?:`([^\s`:\p{Cc}]+)`|([^\s`:\p{Cc}]+))[\t ]*:[\t ]*(.*)$/u.exec(
        line,
      );
    const id = answer?.[1] ?? answer?.[2];
    if (id === undefined) continue;
    if (!ids.has(id)) add(`unknown id ${shortId(id)} at line ${number}`);
    if (answered.has(id)) add(`duplicate id ${shortId(id)} at line ${number}`);
    answered.add(id);
    const text = (answer?.[3] ?? '').replace(/[*_`]/gu, '').trim();
    const reason = /^(?:[Nn]\/[Aa]|NA)\b[\t ]*(:?)(.*)$/u.exec(text);
    const placeholder = (value: string) =>
      !value || /^(?:<[^<>]+>|TODO|TBD|FIXME|\?|\.\.\.|…|[-.]+)$/iu.test(value);
    if (
      placeholder(text) ||
      (reason !== null && (!reason[1] || placeholder(reason[2]?.trim() ?? '')))
    )
      add(`empty answer for id ${shortId(id)} at line ${number}`);
  }
  if (!found) add('missing Hardening section');
  else
    for (const id of ids)
      if (!answered.has(id)) add(`missing id ${shortId(id)}`);
  return reasons;
}

function shortId(id: string): string {
  const characters = Array.from(id);
  return characters.length > 64 ? `${characters.slice(0, 64).join('')}…` : id;
}

function isParagraphText(line: string): boolean {
  return (
    line.trim() !== '' &&
    !/^ {0,3}(?:#{1,6}(?:[\t ]|$)|>|[-+*][\t ]+|\d+[.)][\t ]+)/u.test(line) &&
    !/^ {0,3}(?:\*{3,}|-{3,}|_{3,})[\t ]*$/u.test(line) &&
    !/^ {4,}\S/u.test(line)
  );
}

/** Data errors are bounded reasons, never excerpts from the brief's answers. */
export function checkBrief(briefPath: string, checklistPath: string): string[] {
  let brief: string;
  let checklist: string;
  try {
    brief = readRegularFile(briefPath, 256 * 1024, 'brief');
  } catch (error) {
    return [
      error instanceof Error && !('code' in error)
        ? error.message
        : 'brief cannot be read',
    ];
  }
  try {
    checklist = readRegularFile(checklistPath, 32 * 1024, 'checklist');
  } catch (error) {
    return [
      error instanceof Error && !('code' in error)
        ? error.message
        : 'checklist cannot be read',
    ];
  }
  return checkText(brief, checklist);
}
