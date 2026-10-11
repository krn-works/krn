// Checkpoint commits include only reviewed in-tree files and identify their session. ADR 0001.
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { Job } from '../core/index.ts';
import { git } from './git.ts';

function statusPaths(output: string): string[] {
  return output
    .split('\0')
    .filter(Boolean)
    .map((field) => field.slice(3));
}

function namePaths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

const sensitiveKey = '(?:api[_-]?key|access[_-]?token|secret|password)';
const secretValuePattern = new RegExp(
  `${sensitiveKey}\\s*[:=]\\s*(?:"[^"\\r\\n]{8,}"|'[^'\\r\\n]{8,}'|[^\\s"']{8,})`,
  'iu',
);
const zodDefaultSecretPattern = new RegExp(
  `${sensitiveKey}\\s*[:=]\\s*z\\.string\\(\\)(?:\\.(?:min|max|length)\\([^)]*\\))*\\.default\\(\\s*(['"])[^'"\\r\\n]{6,}\\1`,
  'iu',
);
const zodStringExpression =
  /z\.string\(\)(?:\.(?:min|max|length)\([^)]*\))*(?:\.default\(\s*((?:'(?:\\.|[^'\\\r\n])*')|(?:"(?:\\.|[^"\\\r\n])*"))\s*\))?/giu;

function inspect(root: string, path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes('..') ||
    path === '.krn' ||
    path.startsWith('.krn/') ||
    (path.startsWith('.git') &&
      path !== '.gitignore' &&
      path !== '.gitattributes') ||
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
    const scannedContent = content.replace(
      zodStringExpression,
      (_expression, defaultLiteral: string | undefined) => defaultLiteral ?? '',
    );
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu.test(content) ||
      secretValuePattern.test(scannedContent) ||
      zodDefaultSecretPattern.test(content)
    )
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
