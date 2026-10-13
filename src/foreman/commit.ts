// Checkpoint commits include only reviewed in-tree files and identify their session. ADR 0001.
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { Job } from '../core/index.ts';
import { git } from './git.ts';

// The key-value matcher skips Zod schemas; their string arguments are checked below.
const secretPattern =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*(?!z\s*\.\s*[A-Za-z_$][A-Za-z\d_$]*\s*\()[^\s"']{8,}/iu;
const knownTokenPattern =
  /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{4,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/u;
const sensitiveZodProperty =
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*:\s*z\s*\./giu;
const stringLiteralPattern = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/gu;
const quotedSensitiveAssignmentPattern =
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\b["']?\s*[:=]\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/giu;

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

function isSecretLikeLiteral(value: string): boolean {
  if (secretPattern.test(value) || knownTokenPattern.test(value)) return true;
  const candidate = value.trim();
  // This heuristic is called only for values attached to sensitive keys.
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
    isSecretLikeLiteral(literal[2] ?? ''),
  );
}

function hasQuotedSensitiveAssignment(content: string): boolean {
  quotedSensitiveAssignmentPattern.lastIndex = 0;
  return [...content.matchAll(quotedSensitiveAssignmentPattern)].some(
    (assignment) => isSecretLikeLiteral(assignment[2] ?? ''),
  );
}

function containsSecret(content: string): boolean {
  for (const property of content.matchAll(sensitiveZodProperty)) {
    const propertyStart = property.index ?? 0;
    const expressionStart = propertyStart + property[0].lastIndexOf('z');
    const end = expressionEnd(content, expressionStart);
    const expression = content.slice(expressionStart, end);
    if (hasSecretLiteral(expression)) return true;
  }

  if (secretPattern.test(content) || knownTokenPattern.test(content))
    return true;
  if (hasQuotedSensitiveAssignment(content)) return true;
  return false;
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

export function commitCheckpoint(
  job: Job,
  message: string,
  sessionId: string,
): string {
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
  git(job, [
    'commit',
    '--no-verify',
    '-m',
    `${message}\n\nKrn-Session: ${sessionId}`,
  ]);
  return git(job, ['rev-parse', 'HEAD']).trim();
}
