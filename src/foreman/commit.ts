// Checkpoint commits include only reviewed in-tree files and identify their session. ADR 0001.
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { Job } from '../core/index.ts';
import { credentialShapeKind } from './credential-shape.ts';
import { git } from './git.ts';

// The key-value matcher skips Zod schemas; their string arguments are checked below.
const secretPattern =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*(?!z\s*\.\s*[A-Za-z_$][A-Za-z\d_$]*\s*\()[^\s"']{8,}/iu;
const sensitiveZodProperty =
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*:\s*z\s*\./giu;
const stringLiteralPattern = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/gu;
const zodChainedLiteralPattern =
  /\.(?:default|catch|describe)\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/gu;

function statusPaths(output: string): string[] {
  return output
    .split('\0')
    .filter(Boolean)
    .map((field) => field.slice(3));
}

function namePaths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function expressionEnd(source: string, start: number): number {
  let parenthesisDepth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') parenthesisDepth++;
    else if (character === ')')
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    else if (
      parenthesisDepth === 0 &&
      (character === ',' || character === '}' || character === ';')
    )
      return index;
  }
  return source.length;
}

function isStructuredMetadataLiteral(value: string): boolean {
  return (
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    /^intent:\d+$/u.test(value) ||
    /^[A-Z]{1,8}\d+[a-z]?-[A-Za-z0-9-]+$/u.test(value) ||
    /^[A-Z]{2,8}-\d{1,8}$/u.test(value)
  );
}

function isLegacyZodSecretLiteral(
  value: string,
  scanStructuredMetadata = true,
): boolean {
  if (secretPattern.test(value)) return true;
  const candidate = value.trim();
  if (scanStructuredMetadata && isStructuredMetadataLiteral(candidate))
    return false;
  return (
    candidate.length >= 6 &&
    !/\s/u.test(candidate) &&
    /[A-Za-z]/u.test(candidate) &&
    /\d/u.test(candidate)
  );
}

function hasSecretLiteral(expression: string): boolean {
  stringLiteralPattern.lastIndex = 0;
  return [...expression.matchAll(stringLiteralPattern)].some((literal) =>
    isLegacyZodSecretLiteral(literal[2] ?? '', false),
  );
}

function hasZodChainedSecretLiteral(content: string): boolean {
  zodChainedLiteralPattern.lastIndex = 0;
  return [...content.matchAll(zodChainedLiteralPattern)].some((literal) => {
    const callStart = literal.index ?? 0;
    const statementStart = content.lastIndexOf(';', callStart) + 1;
    const statementPrefix = content.slice(statementStart, callStart);
    return (
      /\bz\.[A-Za-z_$][A-Za-z\d_$]*\s*\(/u.test(statementPrefix) &&
      isLegacyZodSecretLiteral(literal[2] ?? '')
    );
  });
}

function containsSecret(content: string): boolean {
  if (credentialShapeKind(content) !== null) return true;

  for (const property of content.matchAll(sensitiveZodProperty)) {
    const propertyStart = property.index ?? 0;
    const expressionStart = propertyStart + property[0].lastIndexOf('z');
    const end = expressionEnd(content, expressionStart);
    const expression = content.slice(expressionStart, end);
    if (hasSecretLiteral(expression)) return true;
  }

  if (secretPattern.test(content)) return true;
  return hasZodChainedSecretLiteral(content);
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
    if (containsSecret(content))
      throw new Error(`checkpoint refused: secret pattern in ${path}`);
  }
}

export function prepareCheckpoint(
  job: Job,
  message: string,
  sessionId: string,
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
    checkpointMessage(message, sessionId),
  ]).trim();
  return { sha, parent };
}

// commit-tree stores the message verbatim plus one newline; compare that body exactly.
function checkpointMessage(message: string, sessionId: string): string {
  return `${message}\n\nKrn-Session: ${sessionId}`;
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
): void {
  const head = git(job, ['rev-parse', 'HEAD']).trim();
  if (
    git(job, ['show', '-s', '--format=%P', sha]).trim() !== parent ||
    commitBody(job, sha) !== `${checkpointMessage(message, sessionId)}\n` ||
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
): string {
  const { sha, parent } = prepareCheckpoint(job, message, sessionId);
  publishCheckpoint(job, sha, parent, message, sessionId);
  return sha;
}
