// Refuse candidate changes that can redefine the evaluator or its checks.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { z } from 'zod';

const packageSchema = z
  .object({ scripts: z.record(z.string(), z.string()).optional() })
  .passthrough();

async function git(root: string, args: string[]): Promise<string> {
  const result = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args], {
      cwd: root,
      env: {
        PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        LANG: 'C',
        LC_ALL: 'C',
        HOME: '/tmp/krn-home',
        TMPDIR: '/tmp/krn-home',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
    child.once('error', reject);
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
  if (result.status !== 0)
    throw new Error(result.stderr || 'git command failed');
  return result.stdout.includes('\0') ? result.stdout : result.stdout.trim();
}

async function gitBlob(root: string, oid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, 'cat-file', 'blob', oid], {
      cwd: root,
      env: {
        PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        LANG: 'C',
        LC_ALL: 'C',
        HOME: '/tmp/krn-home',
        TMPDIR: '/tmp/krn-home',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (status) =>
      status === 0
        ? resolve(stdout)
        : reject(new Error(stderr || 'git failed')),
    );
  });
}

function globMatches(pattern: string, path: string): boolean {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (
      character === '/' &&
      pattern[index + 1] === '*' &&
      pattern[index + 2] === '*' &&
      index + 3 === pattern.length
    ) {
      expression += '(?:/.*)?';
      index += 2;
      continue;
    }
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          expression += '(?:.*/)?';
          index += 2;
        } else {
          expression += '.*';
          index += 1;
        }
      } else {
        expression += '[^/]*';
      }
    } else {
      expression += character?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') ?? '';
    }
  }
  return new RegExp(`${expression}$`, 'u').test(path);
}

function isTestPath(path: string): boolean {
  return (
    path.startsWith('test/') ||
    path.startsWith('tests/') ||
    /\.(?:test|spec)\.[^/]+$/u.test(path)
  );
}

function scriptsFrom(raw: string): Record<string, string> {
  return packageSchema.parse(JSON.parse(raw)).scripts ?? {};
}

async function packageScripts(
  root: string,
  revision: string,
  isCandidate: boolean,
): Promise<Record<string, string> | undefined> {
  let entry: string;
  try {
    entry = await git(root, ['ls-tree', '-z', revision, '--', 'package.json']);
  } catch {
    return isCandidate ? undefined : {};
  }
  if (!entry) return isCandidate ? undefined : {};
  const [metadata, entryPathWithTerminator] = entry.split('\t');
  const [mode, type, oid] = metadata?.split(/\s+/u) ?? [];
  if (entryPathWithTerminator?.replace(/\0$/u, '') !== 'package.json')
    return isCandidate ? undefined : {};
  if (type !== 'blob' || !oid || !['100644', '100755'].includes(mode ?? ''))
    return isCandidate ? undefined : {};

  let size: number;
  try {
    size = Number(await git(root, ['cat-file', '-s', oid]));
  } catch {
    return isCandidate ? undefined : {};
  }
  if (size > 1024 * 1024) return isCandidate ? undefined : {};
  let raw: string;
  try {
    raw = await gitBlob(root, oid);
  } catch {
    return isCandidate ? undefined : {};
  }
  try {
    return scriptsFrom(raw);
  } catch {
    if (isCandidate)
      throw new Error('candidate package.json is not valid JSON');
    return {};
  }
}

export async function evaluatorSurfaceChanges(
  root: string,
  base: string,
  sha: string,
  protectedGlobs: readonly string[],
): Promise<string[]> {
  const diff = await git(root, [
    'diff',
    '--name-status',
    '-z',
    '--no-renames',
    base,
    sha,
  ]);
  const fields = diff.split('\0').filter(Boolean);
  const entries: { status: string; path: string }[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (status && path) entries.push({ status, path });
  }
  const findings = new Set<string>();
  for (const { status, path } of entries) {
    if (
      path === 'krn.checks.json' ||
      path === '.npmrc' ||
      path.startsWith('.github/') ||
      (status === 'D' &&
        (/^test\//u.test(path) ||
          /^tests\//u.test(path) ||
          /\.(?:test|spec)\.[^/]+$/u.test(path)))
    )
      findings.add(`evaluator surface changed: ${path}`);
    if (protectedGlobs.some((pattern) => globMatches(pattern, path)))
      findings.add(`evaluator surface changed: ${path}`);
  }

  const testPaths = [
    ...new Set(
      entries
        .filter(({ status, path }) => status !== 'D' && isTestPath(path))
        .map(({ path }) => path),
    ),
  ];
  const testTokenSeparator = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n]*(?:\r?\n|$))*`;
  const disabledTestToken = new RegExp(
    String.raw`(?:\.(?:skip|todo|only)|\[\s*(['"])(?:skip|todo|only)\1\s*\])${testTokenSeparator}(?:\?\.)?${testTokenSeparator}\(|(?:^|\s|[,{])skip\s*:\s*true\b|\[\s*(['"])skip\2\s*\]${testTokenSeparator}:${testTokenSeparator}true\b`,
    'u',
  );
  for (const path of testPaths) {
    const addedLines = await git(root, [
      'diff',
      '-U0',
      '--no-ext-diff',
      base,
      sha,
      '--',
      `:(literal)${path}`,
    ]);
    const addedText = addedLines
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n');
    if (disabledTestToken.test(addedText))
      findings.add(`evaluator surface changed: ${path} (test disabled)`);
  }

  if (entries.some(({ path }) => path === 'package.json')) {
    const baseScripts = (await packageScripts(root, base, false)) ?? {};
    let candidateScripts: Record<string, string> | undefined;
    try {
      candidateScripts = await packageScripts(root, sha, true);
    } catch {
      findings.add('evaluator surface changed: package.json');
      return [...findings].sort().slice(0, 16);
    }
    if (!candidateScripts) {
      findings.add('evaluator surface changed: package.json');
      return [...findings].sort().slice(0, 16);
    }
    for (const name of new Set([
      ...Object.keys(baseScripts),
      ...Object.keys(candidateScripts),
    ])) {
      if (baseScripts[name] !== candidateScripts[name])
        findings.add(`evaluator surface changed: package.json#scripts.${name}`);
    }
  }
  return [...findings].sort().slice(0, 16);
}
