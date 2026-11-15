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
  if (paths.length === 0) return siblingSection(repo, brief, budget);
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

const SOURCE_EXT = /\.(?:php|py|go|rs|ts|mts|mjs|js|jsx|tsx|rb|java|kt)$/u;
const TEST_PATH =
  /(?:^|\/)(?:tests?|spec|__tests__)\/|(?:Test\.php|_test\.(?:go|py|rs)|(?:^|\/)test_[^/]+\.py|\.(?:test|spec)\.[a-z]+)$/u;
const STOP_WORDS = new Set([
  'about',
  'after',
  'before',
  'behavior',
  'brief',
  'change',
  'commit',
  'every',
  'goal',
  'should',
  'scope',
  'task',
  'test',
  'tests',
  'there',
  'their',
  'which',
  'would',
  'when',
  'where',
  'with',
  'without',
  'write',
  'writes',
  'return',
  'returns',
  'outcome',
  'proof',
  'files',
  'file',
  'that',
  'this',
  'from',
  'into',
]);
const IDENTIFIERS_MAX = 8;
const SIBLINGS_MAX = 5;

/** Goal identifiers: backticked tokens, then snake/camel/Pascal words, then long plain words. */
export function goalIdentifiers(brief: string): string[] {
  const ranked: string[] = [];
  for (const m of brief.matchAll(/`([^`\s]+)`/gu)) {
    const token = (m[1] as string).replace(/\(\)$/u, '');
    for (const part of token.split(/[\\/:>.\s]+|->|::/u)) ranked.push(part);
  }
  const words = brief.match(/[A-Za-z][A-Za-z0-9_]{3,}/gu) ?? [];
  const compound = words.filter(
    (w) =>
      /_/u.test(w) || /[a-z][A-Z]/u.test(w) || /^[A-Z][a-z]+[A-Z]/u.test(w),
  );
  const plain = words.filter((w) => w.length >= 6);
  const out: string[] = [];
  for (const word of [...ranked, ...compound, ...plain]) {
    const key = word.toLowerCase();
    if (word.length < 4 || STOP_WORDS.has(key)) continue;
    if (out.some((o) => o.toLowerCase() === key)) continue;
    out.push(word);
    if (out.length >= IDENTIFIERS_MAX) break;
  }
  return out;
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

/**
 * Siblings for a brief without a Scope: line: tracked files in any stack (php, py, go, rs,
 * tests/ layouts) that mention the goal identifiers or carry one in their name, split into
 * tests and helpers, best match first.
 */
export function siblingSection(
  repo: string,
  brief: string,
  budget = PRECEDENT_BUDGET,
): string {
  const ids = goalIdentifiers(brief);
  if (ids.length === 0) return '';
  const score = new Map<string, number>();
  const bump = (file: string) => score.set(file, (score.get(file) ?? 0) + 1);
  const files = git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])
    .split('\n')
    .filter((f) => SOURCE_EXT.test(f));
  for (const id of ids) {
    const needle = squash(id);
    for (const f of files)
      if (
        needle.length >= 4 &&
        squash(f.split('/').pop() as string).includes(needle)
      )
        bump(f);
    const hits = git(repo, ['grep', '-l', '-i', '-F', '-e', id, 'HEAD', '--']);
    for (const line of hits.split('\n')) {
      const f = line.replace(/^HEAD:/u, '');
      if (f !== '' && SOURCE_EXT.test(f)) bump(f);
    }
  }
  const ranked = [...score.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const tests = ranked
    .filter(([f]) => TEST_PATH.test(f))
    .slice(0, SIBLINGS_MAX);
  const helpers = ranked
    .filter(([f]) => !TEST_PATH.test(f))
    .slice(0, SIBLINGS_MAX);
  if (tests.length === 0 && helpers.length === 0) return '';
  const list = (rows: [string, number][]) =>
    rows.map(([f]) => `- \`${f}\``).join('\n');
  const parts = [
    `Precedent (no Scope: line; siblings found in HEAD by goal identifiers ${ids.map((i) => `\`${i}\``).join(', ')}; put the new test beside the first sibling test and reuse its helpers):`,
  ];
  if (tests.length > 0) parts.push(`Sibling tests:\n${list(tests)}`);
  if (helpers.length > 0) parts.push(`Sibling helpers:\n${list(helpers)}`);
  let text = parts.join('\n');
  if (text.length > budget) {
    const cut = text.slice(0, budget - 5);
    text = `${cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0))}\n...`;
  }
  return text;
}
