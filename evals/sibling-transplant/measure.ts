// Usage: node evals/sibling-transplant/measure.ts <lang:ts|py> <repo-dir> [prs=50]
// Population, fixed before any result: the newest first-parent commits of HEAD (merge or squash commits, no
// reverts) that add at least one test case; a case counts as added when no case of the same name exists in the
// same (or renamed-from) test file of the first parent. Pool: every test case of the first parent's tree.
// Cases under MIN_TOKENS abstract tokens are trivial and left out of the denominator and reported separately.
import { execFileSync } from 'node:child_process';
import {
  clusterBootstrap,
  extractCases,
  type Fingerprint,
  fingerprint,
  hasAncestor,
  isFix,
  isTestPath,
  type Lang,
  MIN_TOKENS,
  nearest,
  SHINGLE,
  THRESHOLD,
  wilson,
} from './detector.ts';

const [langArg, repo, nArg] = process.argv.slice(2);
if ((langArg !== 'ts' && langArg !== 'py') || !repo) {
  console.error('usage: measure.ts <ts|py> <repo-dir> [prs]');
  process.exit(64);
}
const lang: Lang = langArg;
const want = Number(nArg ?? 50);
const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const blobCache = new Map<string, { name: string; body: string }[]>();
const fpCache = new Map<string, Fingerprint[]>();

function cases(blob: string) {
  let c = blobCache.get(blob);
  if (!c) {
    c = extractCases(git('cat-file', 'blob', blob), lang);
    blobCache.set(blob, c);
  }
  return c;
}
function poolOf(blob: string) {
  let f = fpCache.get(blob);
  if (!f) {
    f = cases(blob).map((c) => fingerprint(c.body));
    fpCache.set(blob, f);
  }
  return f;
}

const head = git('rev-parse', 'HEAD').trim();
const log = git('log', '--first-parent', '--no-merges', '--format=%H%x09%P%x09%s', head)
  .trim()
  .split('\n');
// --no-merges would drop true merge commits; squash-merged histories are linear so use it only when linear.
const merges = git('log', '--first-parent', '--merges', '--format=%H%x09%P%x09%s', '-n', '1', head).trim();
const commits = (merges ? git('log', '--first-parent', '--format=%H%x09%P%x09%s', head).trim().split('\n') : log).map(
  (l) => l.split('\t') as [string, string, string],
);

interface Row {
  sha: string;
  subject: string;
  fix: boolean;
  added: number;
  trivial: number;
  scored: number;
  hits: number;
}
const rows: Row[] = [];
let newest = '';
let oldest = '';
for (const [sha, parents, subject] of commits) {
  if (rows.length >= want) break;
  const parent = parents.split(' ')[0];
  if (!parent || /^revert\b/i.test(subject)) continue;
  const changes = git('diff-tree', '-r', '-M', '--no-commit-id', '--name-status', parent, sha)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
  const touched = changes.filter((c) => (c[0] ?? '')[0] !== 'D' && isTestPath(c[c.length - 1] ?? '', lang));
  if (touched.length === 0) continue;
  const tree = new Map<string, string>();
  for (const l of git('ls-tree', '-r', parent).trim().split('\n')) {
    const m = /^\d+ blob (\w+)\t(.*)$/.exec(l);
    if (m && isTestPath(m[2] as string, lang)) tree.set(m[2] as string, m[1] as string);
  }
  const pool: Fingerprint[] = [];
  for (const b of tree.values()) pool.push(...poolOf(b));
  const row: Row = { sha, subject, fix: isFix(subject), added: 0, trivial: 0, scored: 0, hits: 0 };
  for (const c of touched) {
    const status = (c[0] ?? '')[0];
    const path = c[c.length - 1] as string;
    const oldPath = status === 'R' ? (c[1] as string) : path;
    const before = new Set((tree.has(oldPath) ? cases(tree.get(oldPath) as string) : []).map((x) => x.name));
    const blob = git('rev-parse', `${sha}:${path}`).trim();
    for (const k of cases(blob)) {
      if (before.has(k.name)) continue;
      row.added++;
      const fp = fingerprint(k.body);
      if (fp.tokens < MIN_TOKENS) {
        row.trivial++;
        continue;
      }
      row.scored++;
      if (hasAncestor(nearest(fp, pool))) row.hits++;
    }
  }
  if (row.added === 0) continue;
  rows.push(row);
  newest ||= sha;
  oldest = sha;
}

const sum = (rs: Row[], f: (r: Row) => number) => rs.reduce((a, r) => a + f(r), 0);
function stat(rs: Row[]) {
  const k = sum(rs, (r) => r.hits);
  const n = sum(rs, (r) => r.scored);
  return {
    prs: rs.length,
    added: sum(rs, (r) => r.added),
    trivial: sum(rs, (r) => r.trivial),
    scored: n,
    hits: k,
    share: n ? k / n : null,
    wilson: wilson(k, n),
    bootstrap: clusterBootstrap(rs.map((r) => ({ hits: r.hits, n: r.scored }))),
    prsWithAncestor: rs.filter((r) => r.hits > 0).length,
  };
}
console.log(
  JSON.stringify(
    {
      repo,
      lang,
      head,
      newest,
      oldest,
      threshold: THRESHOLD,
      shingle: SHINGLE,
      minTokens: MIN_TOKENS,
      all: stat(rows),
      fix: stat(rows.filter((r) => r.fix)),
      feature: stat(rows.filter((r) => !r.fix)),
      rows,
    },
    null,
    1,
  ),
);
