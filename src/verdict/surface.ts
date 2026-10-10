// Refuse candidates that alter the commands or inputs used to evaluate them.

import { z } from 'zod';
import { git } from './registry.ts';

const packageSchema = z
  .object({
    scripts: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

type DiffItem = { readonly status: string; readonly path: string };

function parseDiff(raw: string): DiffItem[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('\t');
      if (separator < 1) throw new Error('invalid git diff name-status output');
      return {
        status: line.slice(0, separator),
        path: line.slice(separator + 1),
      };
    });
}

function globMatches(pattern: string, path: string): boolean {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? '';
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'u').test(path);
}

function isTestPath(path: string): boolean {
  return (
    /^(?:test|tests)\//u.test(path) ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/u.test(path)
  );
}

async function packageScripts(
  root: string,
  revision: string,
): Promise<Record<string, string> | undefined> {
  let raw: string;
  try {
    raw = await git(root, ['show', `${revision}:package.json`]);
  } catch {
    return undefined;
  }
  const parsed = packageSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`invalid package.json at ${revision}`);
  return parsed.data.scripts ?? {};
}

export async function evaluatorSurfaceChanges(
  root: string,
  base: string,
  sha: string,
  protectedGlobs: readonly string[],
): Promise<string[]> {
  const diff = parseDiff(
    await git(root, ['diff', '--name-status', '--no-renames', base, sha]),
  );
  const findings = new Set<string>();
  const packageChanged = diff.some((item) => item.path === 'package.json');

  for (const { status, path } of diff) {
    if (path === 'package.json') continue;
    if (
      path === 'krn.checks.json' ||
      path === '.github' ||
      path.startsWith('.github/') ||
      (status === 'D' && isTestPath(path)) ||
      protectedGlobs.some((pattern) => globMatches(pattern, path))
    )
      findings.add(`evaluator surface changed: ${path}`);
  }

  if (packageChanged) {
    try {
      const [baseScripts, candidateScripts] = await Promise.all([
        packageScripts(root, base),
        packageScripts(root, sha),
      ]);
      const before = baseScripts ?? {};
      const after = candidateScripts ?? {};
      for (const name of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ]))
        if (before[name] !== after[name])
          findings.add(
            `evaluator surface changed: package.json#scripts.${name}`,
          );
    } catch {
      findings.add('evaluator surface changed: package.json');
    }
  }

  return [...findings].sort().slice(0, 16);
}
