// `krn standards review`: the standards a worker's diff can break, checked before Stop. For every
// changed file (the diff against the merge-base with main, plus untracked files) it lists the
// enforced records that apply to it and, where a record is a `git grep` pattern scan, the offending
// file:line. A record whose enforcement cannot name a line is left to `krn standards check`.
import { spawnSync } from 'node:child_process';
import type { Standard } from './standards.ts';

/** One offending line of a changed file. */
export type Violation = {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
};

export type Review = {
  /** Changed files, sorted. */
  readonly files: readonly string[];
  /** For each changed file, the ids of the line-checkable records that apply to it. */
  readonly applicable: ReadonlyMap<string, readonly string[]>;
  readonly violations: readonly Violation[];
  /** Enforced records that apply but cannot name a line; `krn standards check` runs them. */
  readonly stopOnly: readonly string[];
};

type Scan = {
  readonly ignoreCase: boolean;
  readonly pattern: string;
  readonly pathspecs: readonly string[];
};

const GREP_FORM = /^!\s*git grep\s+-q([IiE]+)\s+'([^']*)'(?:\s+--\s+(.*))?$/;
const DIFF_CHECK_FORM = /^!\s*git rev-parse[^|]*\|\|\s*git diff --check HEAD$/;
const SPEC = /'([^']*)'|(\S+)/g;

/** The pattern scan a `command` enforcement amounts to, or undefined when it is anything else. */
export function scanOf(standard: Standard): Scan | undefined {
  if (standard.enforcement.kind !== 'command') return undefined;
  const match = GREP_FORM.exec(standard.enforcement.run.trim());
  if (match === null || !(match[1] ?? '').includes('E')) return undefined;
  const pathspecs = [...(match[3] ?? '').matchAll(SPEC)].map(
    (token) => token[1] ?? token[2] ?? '',
  );
  return {
    ignoreCase: (match[1] ?? '').includes('i'),
    pattern: match[2] ?? '',
    pathspecs,
  };
}

function git(root: string, args: readonly string[]): string | undefined {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])
    delete env[name];
  const done = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return done.status === 0 ? done.stdout : undefined;
}

/** The commit the diff is taken against when no base is named: the merge-base with origin/main or main, else HEAD. */
function baseOf(root: string): string {
  for (const branch of ['origin/main', 'main']) {
    const base = git(root, ['merge-base', 'HEAD', branch])?.trim();
    if (base) return base;
  }
  return 'HEAD';
}

/** The PR base a review is bound to: the base branch tip that supplies the rules and the merge-base the diff starts from. */
export type ReviewBase = {
  readonly branch: string;
  /** Tip of the base branch: its records judge the head. */
  readonly tip: string;
  /** Merge-base of HEAD and the base tip: the diff starts here. */
  readonly mergeBase: string;
  readonly head: string;
};

/** Resolves `branch` (as origin/<branch>, else local) against HEAD; undefined when neither exists. */
export function resolveBase(
  root: string,
  branch: string,
): ReviewBase | undefined {
  const head = git(root, ['rev-parse', 'HEAD'])?.trim();
  if (!head) return undefined;
  for (const ref of [`origin/${branch}`, branch]) {
    const tip = git(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ])?.trim();
    const mergeBase = tip && git(root, ['merge-base', 'HEAD', tip])?.trim();
    if (tip && mergeBase) return { branch, tip, mergeBase, head };
  }
  return undefined;
}

/** Files that differ from the merge-base (committed or not) and untracked files, deleted ones excluded. */
export function changedFiles(root: string, mergeBase?: string): string[] {
  const base = mergeBase ?? baseOf(root);
  const diff =
    git(root, ['diff', '--name-only', '-z', '--diff-filter=d', base]) ??
    git(root, ['ls-files', '-z']) ??
    '';
  const untracked =
    git(root, ['ls-files', '-z', '--others', '--exclude-standard']) ?? '';
  return [
    ...new Set(`${diff}${untracked}`.split('\0').filter((name) => name !== '')),
  ].sort();
}

/** The content of `path` at commit `rev`, undefined when the commit has no such file. */
export function fileAt(
  root: string,
  rev: string,
  path: string,
): string | undefined {
  return git(root, ['show', `${rev}:${path}`]);
}

const HIT = /^(.+?):(\d+):(.*)$/;

/** Reviews `files` against the enforced `standards`; `root` is a git top level. */
export function reviewStandards(
  root: string,
  standards: readonly Standard[],
  files: readonly string[] = changedFiles(root),
): Review {
  const changed = new Set(files);
  const applicable = new Map<string, string[]>(files.map((file) => [file, []]));
  const violations: Violation[] = [];
  const stopOnly: string[] = [];
  for (const standard of standards) {
    if (standard.enforcement.kind === 'advisory') continue;
    const scan = scanOf(standard);
    if (scan === undefined) {
      if (
        standard.enforcement.kind === 'command' &&
        DIFF_CHECK_FORM.test(standard.enforcement.run.trim())
      )
        for (const hit of diffCheckHits(root, standard.id, changed))
          violations.push(hit);
      stopOnly.push(standard.id);
      continue;
    }
    const spec = ['--', ...scan.pathspecs];
    const scoped = new Set(
      (
        git(root, [
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
          ...spec,
        ]) ?? ''
      )
        .split('\0')
        .filter((name) => changed.has(name)),
    );
    for (const file of scoped) applicable.get(file)?.push(standard.id);
    if (scoped.size === 0) continue;
    const out =
      git(root, [
        'grep',
        '-nI',
        '--untracked',
        ...(scan.ignoreCase ? ['-i'] : []),
        '-E',
        scan.pattern,
        ...spec,
      ]) ?? '';
    for (const row of out.split('\n')) {
      const hit = HIT.exec(row);
      if (hit === null || !scoped.has(hit[1] ?? '')) continue;
      violations.push({
        id: standard.id,
        file: hit[1] ?? '',
        line: Number(hit[2]),
        text: (hit[3] ?? '').trim().slice(0, 120),
      });
    }
  }
  const stops = stopOnly.filter(
    (id) => !violations.some((violation) => violation.id === id),
  );
  return { files, applicable, violations, stopOnly: [...new Set(stops)] };
}

/** `git diff --check` output rows (`file:line: message`) of changed files. */
function diffCheckHits(
  root: string,
  id: string,
  changed: ReadonlySet<string>,
): Violation[] {
  const done = spawnSync('git', ['-C', root, 'diff', '--check', 'HEAD'], {
    encoding: 'utf8',
  });
  const hits: Violation[] = [];
  for (const row of done.stdout.split('\n')) {
    const hit = /^(.+?):(\d+): (.*)$/.exec(row);
    if (hit === null || !changed.has(hit[1] ?? '')) continue;
    hits.push({
      id,
      file: hit[1] ?? '',
      line: Number(hit[2]),
      text: hit[3] ?? '',
    });
  }
  return hits;
}

/** The report lines: the per-file applicable records, one `VIOLATION file:line id` row each, then the verdict. */
export function renderReview(review: Review, base?: ReviewBase): string[] {
  const lines: string[] = [];
  if (base !== undefined)
    lines.push(
      `rules of ${base.branch}@${base.tip.slice(0, 12)} judge head ${base.head.slice(0, 12)}`,
    );
  for (const file of review.files) {
    const ids = review.applicable.get(file) ?? [];
    if (ids.length > 0) lines.push(`${file}: ${ids.join(' ')}`);
  }
  for (const v of review.violations)
    lines.push(`VIOLATION ${v.file}:${v.line} ${v.id}: ${v.text}`);
  if (review.stopOnly.length > 0)
    lines.push(
      `not line-checkable here (krn standards check runs them): ${review.stopOnly.join(' ')}`,
    );
  lines.push(
    review.violations.length === 0
      ? `PASS standards review: ${review.files.length} changed file(s), no violation`
      : `FAIL standards review: ${review.violations.length} violation(s) in ${review.files.length} changed file(s)`,
  );
  return lines;
}
