// Deterministic floor against weakened tests: a pull request diff must not
// remove assertions, add skip/only/todo, or delete a test file while its target
// stays, unless the PR body carries a `Weakens-tests: <reason>` line.
// Diff-based; runs no tests. Fails only on a real finding.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TEST_FILE = /(^|\/)[^/]+\.test\.(?:ts|mjs|js|mts|cts)$/u;
const ASSERTION = /\b(?:assert(?:\.\w+)?|expect|t\.assert\.\w+)\s*\(/gu;
const DISABLER =
  /\b(?:it|test|describe|suite)\.(?:skip|only|todo)\b|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|\bskip\s*:\s*(?:true|['"`])/u;
const REASON = /^\s*Weakens-tests:\s*\S+/imu;

const countAssertions = (lines) =>
  lines.reduce((sum, line) => sum + (line.match(ASSERTION)?.length ?? 0), 0);

/** Split a unified diff into per-file records. */
export function parseDiff(diff) {
  const files = [];
  let current;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (header) {
      current = { path: header[2], deleted: false, added: [], removed: [] };
      files.push(current);
    } else if (!current) {
    } else if (line.startsWith('deleted file mode')) {
      current.deleted = true;
    } else if (line.startsWith('+++') || line.startsWith('---')) {
    } else if (line.startsWith('+')) {
      current.added.push(line.slice(1));
    } else if (line.startsWith('-')) {
      current.removed.push(line.slice(1));
    }
  }
  return files;
}

const stemOf = (path) =>
  (path.split('/').pop() ?? '').replace(/\.test\.\w+$/u, '');

/**
 * @param {{diff: string, body?: string, targetExists: (stem: string) => boolean}} input
 * @returns {{ok: boolean, overridden: boolean, findings: string[]}}
 */
export function checkWeakTests({ diff, body = '', targetExists }) {
  const findings = [];
  for (const file of parseDiff(diff)) {
    if (!TEST_FILE.test(file.path)) continue;
    if (file.deleted) {
      if (targetExists(stemOf(file.path)))
        findings.push(
          `${file.path}: test file deleted while its target "${stemOf(file.path)}" remains`,
        );
      continue;
    }
    const disabled = file.added.filter((line) => DISABLER.test(line));
    for (const line of disabled)
      findings.push(`${file.path}: adds skip/only/todo: ${line.trim()}`);
    const lost = countAssertions(file.removed) - countAssertions(file.added);
    if (lost > 0)
      findings.push(`${file.path}: net ${lost} assertion(s) removed`);
  }
  const overridden = findings.length > 0 && REASON.test(body);
  return { ok: findings.length === 0 || overridden, overridden, findings };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.log('weak-tests: no base/head, skipped');
    process.exit(0);
  }
  const git = (...args) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  const diff = git('diff', '--no-renames', '-U0', `${base}...${head}`);
  const stems = new Set(
    git('ls-tree', '-r', '--name-only', head)
      .split('\n')
      .filter((path) => path && !TEST_FILE.test(path))
      .map((path) => stemOf(path).replace(/\.\w+$/u, '')),
  );
  const result = checkWeakTests({
    diff,
    body: process.env.PR_BODY ?? '',
    targetExists: (stem) => stems.has(stem),
  });
  for (const finding of result.findings) console.log(`weak-tests: ${finding}`);
  if (result.overridden)
    console.log('weak-tests: overridden by Weakens-tests line');
  if (!result.ok) {
    console.error(
      'weak-tests: add "Weakens-tests: <reason>" to the PR body if intended',
    );
    process.exit(1);
  }
  console.log('weak-tests: ok');
}
