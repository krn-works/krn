// Checkpoint commits include only reviewed in-tree files and identify their session. ADR 0001.
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { Job } from '../core/index.ts';
import type { DeliveryTrailers } from '../ledger/delivery.ts';
import { credentialShapeKind } from './credential-shape.ts';
import { git } from './git.ts';

// C4 compatibility debt: the unquoted guard can also reject type references such as PasswordInput.
const secretPattern =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*(?!z\s*\.\s*[A-Za-z_$][A-Za-z\d_$]*\s*\()[^\s"']{8,}/iu;
const SENSITIVE_BINDING_NAME =
  /\b(?:password|secret|api[_-]?key|access[_-]?token)\b/iuy;
const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/u;
const WHITESPACE = /\s/u;
type CredentialFinding = 'secret pattern' | 'analysis limit';

function statusPaths(output: string): string[] {
  return output
    .split('\0')
    .filter(Boolean)
    .map((field) => field.slice(3));
}

function namePaths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function skipComment(source: string, start: number, limit: number): number {
  if (source[start] !== '/' || start + 1 >= limit) return start;
  const marker = source[start + 1];
  if (marker === '/') {
    let index = start + 2;
    while (index < limit && source[index] !== '\n' && source[index] !== '\r')
      index++;
    return index;
  }
  if (marker === '*') {
    let index = start + 2;
    while (
      index + 1 < limit &&
      !(source[index] === '*' && source[index + 1] === '/')
    )
      index++;
    return index + 1 < limit ? index + 2 : limit;
  }
  return start;
}

function lineWindowEnd(source: string, nameEnd: number): number {
  const limit = Math.min(source.length, nameEnd + 80);
  for (let index = nameEnd; index < limit; index++) {
    if (source[index] === '\n' || source[index] === '\r') return index;
  }
  return limit;
}

function readStaticLiteral(
  source: string,
  start: number,
): { readonly finding: CredentialFinding | null; readonly end: number } {
  const quote = source[start] ?? '';
  const limit = Math.min(source.length, start + 256);
  let index = start + 1;
  while (index < limit) {
    const character = source[index] ?? '';
    if (character === quote)
      return {
        finding: index - start - 1 >= 6 ? 'secret pattern' : null,
        end: index + 1,
      };
    if (WHITESPACE.test(character)) return { finding: null, end: index + 1 };
    if (
      quote === '`' &&
      character === '$' &&
      index + 1 < limit &&
      source[index + 1] === '{'
    )
      return { finding: null, end: index + 2 };
    if (character === '\\') {
      if (index + 1 >= limit) break;
      if (WHITESPACE.test(source[index + 1] ?? ''))
        return { finding: null, end: index + 2 };
      index += 2;
    } else index++;
  }
  return { finding: 'analysis limit', end: limit };
}

function quotedValueStart(
  source: string,
  start: number,
  windowEnd: number,
): number | null {
  let index = start;
  while (index < windowEnd) {
    const character = source[index] ?? '';
    if (character === '\n' || character === '\r') return null;
    const commentEnd = skipComment(source, index, windowEnd);
    if (commentEnd !== index) index = commentEnd;
    else if (WHITESPACE.test(character) || character === '(') index++;
    else break;
  }
  const character = source[index] ?? '';
  return character === "'" || character === '"' || character === '`'
    ? index
    : null;
}

function findingAfterOperator(
  source: string,
  start: number,
  windowEnd: number,
): CredentialFinding | null {
  const valueStart = quotedValueStart(source, start, windowEnd);
  return valueStart === null
    ? null
    : readStaticLiteral(source, valueStart).finding;
}

function skipQuotedWindow(
  source: string,
  start: number,
  windowEnd: number,
): number {
  const quote = source[start] ?? '';
  let index = start + 1;
  while (index < windowEnd) {
    const character = source[index] ?? '';
    if (character === '\\') index += Math.min(2, windowEnd - index);
    else if (character === quote) return index + 1;
    else index++;
  }
  return windowEnd;
}

function isBindingEquals(source: string, index: number): boolean {
  const previous = source[index - 1] ?? '';
  const next = source[index + 1] ?? '';
  return !/[=!<>+\-*%&|^]/u.test(previous) && next !== '=' && next !== '>';
}

function methodArgumentStart(
  source: string,
  index: number,
  method: '.default' | '.catch',
  windowEnd: number,
): number | null {
  if (!source.startsWith(method, index)) return null;
  let cursor = index + method.length;
  if (IDENTIFIER_CHARACTER.test(source[cursor] ?? '')) return null;
  while (cursor < windowEnd) {
    const commentEnd = skipComment(source, cursor, windowEnd);
    if (commentEnd !== cursor) cursor = commentEnd;
    else if (WHITESPACE.test(source[cursor] ?? '')) cursor++;
    else break;
  }
  return source[cursor] === '(' ? cursor + 1 : null;
}

function scanRootMethodChain(
  source: string,
  start: number,
  windowEnd: number,
  baseParenthesisDepth: number,
): CredentialFinding | null {
  let index = start;
  let parenthesisDepth = baseParenthesisDepth;
  let nestedObjectDepth = 0;
  while (index < windowEnd) {
    const character = source[index] ?? '';
    const commentEnd = skipComment(source, index, windowEnd);
    if (commentEnd !== index) {
      index = commentEnd;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      index = skipQuotedWindow(source, index, windowEnd);
      continue;
    }
    if (character === '{') {
      nestedObjectDepth++;
      index++;
      continue;
    }
    if (character === '}' && nestedObjectDepth > 0) {
      nestedObjectDepth--;
      index++;
      continue;
    }
    if (nestedObjectDepth > 0) {
      index++;
      continue;
    }
    if (character === '(') {
      parenthesisDepth++;
      index++;
      continue;
    }
    if (character === ')') {
      if (parenthesisDepth === baseParenthesisDepth) return null;
      parenthesisDepth--;
      index++;
      continue;
    }
    if (parenthesisDepth === baseParenthesisDepth) {
      if (
        character === '\n' ||
        character === '\r' ||
        character === ',' ||
        character === ';' ||
        character === '}'
      )
        break;
      if (character === '.') {
        const valueStart =
          methodArgumentStart(source, index, '.default', windowEnd) ??
          methodArgumentStart(source, index, '.catch', windowEnd);
        if (valueStart !== null) {
          const finding = findingAfterOperator(source, valueStart, windowEnd);
          if (finding !== null) return finding;
        }
      }
    }
    index++;
  }
  return null;
}

function scanBoundExpression(
  source: string,
  start: number,
  windowEnd: number,
): CredentialFinding | null {
  let index = start;
  let parenthesisDepth = 0;
  while (index < windowEnd) {
    const character = source[index] ?? '';
    if (character === '\n' || character === '\r') return null;
    const commentEnd = skipComment(source, index, windowEnd);
    if (commentEnd !== index) index = commentEnd;
    else if (WHITESPACE.test(character)) index++;
    else if (character === '(') {
      parenthesisDepth++;
      index++;
    } else break;
  }

  const first = source[index] ?? '';
  if (first === "'" || first === '"' || first === '`')
    return readStaticLiteral(source, index).finding;
  if (first === '{') return null;

  if (/[A-Za-z_$]/u.test(first)) {
    let identifierEnd = index + 1;
    while (
      identifierEnd < windowEnd &&
      IDENTIFIER_CHARACTER.test(source[identifierEnd] ?? '')
    )
      identifierEnd++;
    let afterIdentifier = identifierEnd;
    while (afterIdentifier < windowEnd) {
      const characterAfterIdentifier = source[afterIdentifier] ?? '';
      if (
        characterAfterIdentifier === '\n' ||
        characterAfterIdentifier === '\r'
      )
        break;
      const commentEnd = skipComment(source, afterIdentifier, windowEnd);
      if (commentEnd !== afterIdentifier) afterIdentifier = commentEnd;
      else if (WHITESPACE.test(characterAfterIdentifier)) afterIdentifier++;
      else break;
    }
    if (
      source[afterIdentifier] === '=' &&
      isBindingEquals(source, afterIdentifier)
    ) {
      const finding = findingAfterOperator(
        source,
        afterIdentifier + 1,
        windowEnd,
      );
      if (finding !== null) return finding;
    }
  }
  return scanRootMethodChain(source, index, windowEnd, parenthesisDepth);
}

function scanBindingWindow(
  source: string,
  start: number,
  windowEnd: number,
): CredentialFinding | null {
  let index = start;
  while (index < windowEnd) {
    const character = source[index] ?? '';
    if (character === '\n' || character === '\r') break;
    const commentEnd = skipComment(source, index, windowEnd);
    if (commentEnd !== index) index = commentEnd;
    else if (WHITESPACE.test(character)) index++;
    else break;
  }

  const character = source[index] ?? '';
  if (character === ':')
    return scanBoundExpression(source, index + 1, windowEnd);
  if (character === '=' && isBindingEquals(source, index))
    return scanBoundExpression(source, index + 1, windowEnd);
  if (character === '.')
    return scanRootMethodChain(source, index, windowEnd, 0);
  return null;
}

function bindingFindingForName(
  source: string,
  nameEnd: number,
): CredentialFinding | null {
  const windowEnd = lineWindowEnd(source, nameEnd);
  let start = nameEnd;
  if (source[start] === "'" || source[start] === '"') start++;
  return scanBindingWindow(source, start, windowEnd);
}

function sensitiveBindingFinding(source: string): CredentialFinding | null {
  let index = 0;
  let quote: string | null = null;
  let escaped = false;
  while (index < source.length) {
    const character = source[index] ?? '';
    if (quote === null) {
      const commentEnd = skipComment(source, index, source.length);
      if (commentEnd !== index) {
        index = commentEnd;
        continue;
      }
    }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      index++;
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      SENSITIVE_BINDING_NAME.lastIndex = index + 1;
      const quotedName = SENSITIVE_BINDING_NAME.exec(source);
      const quotedNameEnd = quotedName
        ? index + 1 + quotedName[0].length
        : index + 1;
      if (quotedName && source[quotedNameEnd] === character) {
        const finding = bindingFindingForName(source, quotedNameEnd);
        if (finding !== null) return finding;
        index = quotedNameEnd + 1;
      } else {
        quote = character;
        index++;
      }
      continue;
    }

    SENSITIVE_BINDING_NAME.lastIndex = index;
    const match = SENSITIVE_BINDING_NAME.exec(source);
    if (match) {
      const nameEnd = index + match[0].length;
      const finding = bindingFindingForName(source, nameEnd);
      if (finding !== null) return finding;
      index = nameEnd;
    } else index++;
  }
  return null;
}

function contentFinding(content: string): CredentialFinding | null {
  if (credentialShapeKind(content) !== null) return 'secret pattern';
  const bindingFinding = sensitiveBindingFinding(content);
  if (bindingFinding !== null) return bindingFinding;
  return secretPattern.test(content) ? 'secret pattern' : null;
}

function inspect(root: string, path: string): void {
  const allowedGitFiles = path === '.gitignore' || path === '.gitattributes';
  if (
    !path ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes('..') ||
    path === '.krn' ||
    path.startsWith('.krn/') ||
    (path.startsWith('.git') && !allowedGitFiles) ||
    path === '.github' ||
    path.startsWith('.github/')
  )
    throw new Error(`checkpoint refused: protected path ${path}`);
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${root}${sep}`))
    throw new Error('checkpoint refused: path escaped worktree');
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.size > 1_000_000)
    throw new Error(`checkpoint refused: file exceeds 1 MB: ${path}`);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(absolute);
    const resolved = resolve(root, dirname(path), target);
    if (
      isAbsolute(target) ||
      (resolved !== root && !resolved.startsWith(`${root}${sep}`))
    )
      throw new Error(`checkpoint refused: escaping symlink ${path}`);
  } else if (stat.isFile()) {
    const content = readFileSync(absolute, 'utf8');
    const finding = contentFinding(content);
    if (finding !== null)
      throw new Error(`checkpoint refused: ${finding} in ${path}`);
  }
}

export function prepareCheckpoint(
  job: Job,
  message: string,
  sessionId: string,
  trailers: DeliveryTrailers = {},
): { readonly sha: string; readonly parent: string } {
  if (!message || message.length > 200 || /[\r\n]/.test(message))
    throw new Error('invalid checkpoint commit message');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId))
    throw new Error('invalid checkpoint session id');
  const root = realpathSync(job.worktree);
  const changed = statusPaths(
    git(job, [
      'status',
      '--porcelain=v1',
      '-z',
      '--no-renames',
      '--untracked-files=all',
    ]),
  );
  if (!changed.length)
    throw new Error('checkpoint refused: no changes to commit');
  for (const path of changed) inspect(root, path);
  git(job, ['add', '--', ...changed]);
  const staged = namePaths(git(job, ['diff', '--cached', '--name-only', '-z']));
  if (!staged.length)
    throw new Error('checkpoint refused: no changes to commit');
  for (const path of staged) inspect(root, path);
  const parent = git(job, ['rev-parse', 'HEAD']).trim();
  const tree = git(job, ['write-tree']).trim();
  const sha = git(job, [
    'commit-tree',
    tree,
    '-p',
    parent,
    '-m',
    checkpointMessage(message, sessionId, trailers),
  ]).trim();
  return { sha, parent };
}

// commit-tree stores the message verbatim plus one newline; compare that body exactly.
function checkpointMessage(
  message: string,
  sessionId: string,
  trailers: DeliveryTrailers = {},
): string {
  const lines = [`Krn-Session: ${sessionId}`];
  if (trailers.ticket) lines.push(`Ticket: ${trailers.ticket}`);
  if (trailers.r1Task) lines.push(`R1-task: ${trailers.r1Task}`);
  return `${message}\n\n${lines.join('\n')}`;
}

function commitBody(job: Job, sha: string): string {
  const object = git(job, ['cat-file', 'commit', sha]);
  const separator = object.indexOf('\n\n');
  return separator < 0 ? '' : object.slice(separator + 2);
}

// The prepared object is durable before the capsule CAS. Publishing moves only
// the expected parent, so a crash cannot require constructing a second commit.
export function publishCheckpoint(
  job: Job,
  sha: string,
  parent: string,
  message: string,
  sessionId: string,
  trailers: DeliveryTrailers = {},
): void {
  const head = git(job, ['rev-parse', 'HEAD']).trim();
  if (
    git(job, ['show', '-s', '--format=%P', sha]).trim() !== parent ||
    commitBody(job, sha) !==
      `${checkpointMessage(message, sessionId, trailers)}\n` ||
    (head !== parent && head !== sha)
  )
    throw new Error('checkpoint refused: prepared commit anchors changed');
  if (head === sha) return;
  if (
    git(job, ['write-tree']).trim() !==
      git(job, ['rev-parse', `${sha}^{tree}`]).trim() ||
    git(job, ['diff', '--name-only']).trim() ||
    git(job, ['ls-files', '--others', '--exclude-standard']).trim()
  )
    throw new Error('checkpoint refused: prepared tree changed');
  git(job, ['update-ref', '-m', 'foreman checkpoint', 'HEAD', sha, parent]);
}

export function commitCheckpoint(
  job: Job,
  message: string,
  sessionId: string,
  trailers: DeliveryTrailers = {},
): string {
  const { sha, parent } = prepareCheckpoint(job, message, sessionId, trailers);
  publishCheckpoint(job, sha, parent, message, sessionId, trailers);
  return sha;
}
