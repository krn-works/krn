// Precedent for a lane brief: what the repository's own history asserted about the modules
// the brief names (messages, exit codes, output shapes), read from commits reachable from HEAD.
import { execFileSync } from 'node:child_process';

/** Total characters of the section; the brief stays small next to the conventions packet. */
export const PRECEDENT_BUDGET = 6000;
const COMMITS_PER_MODULE = 3;
const HUNK_CAP = 900;
const IMPORTERS_MAX = 5;
const MODULE_PATH = /^(?:[\w.-]+\/)+[\w.-]+\.(?:ts|mts|mjs|js)$/u;

/** Module paths a brief names: the `Scope:` line and the backticked path of each interface line. */
export function briefPaths(brief: string): string[] {
  const found: string[] = [];
  for (const line of brief.split('\n')) {
    const scope = /^\s*Scope:\s*(.*)$/iu.exec(line);
    if (scope !== null) {
      for (const token of (scope[1] as string).split(/[\s,;]+/u))
        found.push(token.replace(/^`|`$|[.]$/gu, ''));
    } else if (/^\s*-\s+`/u.test(line)) {
      for (const match of line.matchAll(/`([^`]+)`/gu))
        found.push(match[1] as string);
    }
  }
  const modules = found.filter(
    (path) => MODULE_PATH.test(path) && !path.startsWith('test/'),
  );
  return [...new Set(modules)].sort();
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function testHunks(repo: string, sha: string): string {
  const diff = git(repo, [
    'show',
    '--format=',
    '--unified=2',
    sha,
    '--',
    'test/',
  ]);
  const files = diff.split(/^(?=diff --git )/mu).filter((part) => part !== '');
  const out: string[] = [];
  for (const file of files) {
    const name = /^diff --git a\/(\S+)/u.exec(file)?.[1] ?? '';
    if (!/\.(?:ts|mts|mjs|js)$/u.test(name)) continue;
    const body = file
      .split('\n')
      .filter((line) => /^[-+@ ]/u.test(line) && !/^(---|\+\+\+) /u.test(line))
      .join('\n');
    const clipped =
      body.length > HUNK_CAP ? `${body.slice(0, HUNK_CAP)}\n...` : body;
    out.push(`  ${name}\n${indent(clipped)}`);
  }
  return out.join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function importers(repo: string, path: string): string[] {
  const stem = path.replace(/\.(?:ts|mts|mjs|js)$/u, '');
  const base = stem.split('/').pop() as string;
  const out = git(repo, [
    'grep',
    '-l',
    '-F',
    '-e',
    `/${base}.`,
    'HEAD',
    '--',
    'test/',
  ]);
  return out
    .split('\n')
    .map((line) => line.replace(/^HEAD:/u, ''))
    .filter((line) => line !== '')
    .sort()
    .slice(0, IMPORTERS_MAX);
}

/**
 * The Precedent section for the modules a brief names, or '' when it names none. Commits come
 * from HEAD only (never other refs), are deduplicated across modules, and the section is cut
 * at the budget on a line boundary.
 */
export function precedentSection(
  repo: string,
  brief: string,
  budget = PRECEDENT_BUDGET,
): string {
  const paths = briefPaths(brief);
  if (paths.length === 0) return '';
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const path of paths) {
    const shas = git(repo, [
      'log',
      '-n',
      String(COMMITS_PER_MODULE),
      '--format=%H',
      'HEAD',
      '--',
      path,
    ])
      .split('\n')
      .filter((sha) => sha !== '');
    const lines: string[] = [];
    for (const sha of shas) {
      if (seen.has(sha)) continue;
      seen.add(sha);
      const subject = git(repo, ['show', '-s', '--format=%s', sha]).trim();
      const hunks = testHunks(repo, sha);
      lines.push(`- ${sha.slice(0, 9)} ${subject}`);
      if (hunks !== '') lines.push(hunks);
    }
    const tests = importers(repo, path);
    if (tests.length > 0)
      lines.push(
        `- tests importing it: ${tests.map((t) => `\`${t}\``).join(', ')}`,
      );
    if (lines.length > 0) blocks.push(`### \`${path}\`\n${lines.join('\n')}`);
  }
  if (blocks.length === 0) return '';
  const head =
    'Precedent (commits reachable from HEAD touching the named modules, with the test changes they made; match these messages, exit codes and output shapes):';
  let text = `${head}\n${blocks.join('\n')}`;
  if (text.length > budget) {
    const cut = text.slice(0, budget - 5);
    text = `${cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0))}\n...`;
  }
  return text;
}
