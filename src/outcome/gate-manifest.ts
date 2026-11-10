// The gate manifest: every producer of the CI verdict in two classes, and the commits that touch each.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/** Runner entry points of the verdict; their import closure joins the frame. */
const ENTRY_POINTS = [
  'scripts/test-suite.mjs',
  'scripts/weak-tests.mjs',
  'scripts/ci-changes.mjs',
];
const RUNNER_PATHS = ['package.json'];
const RUNNER_PREFIXES = ['.github/workflows/', '.github/actions/'];
const VALIDATOR_PATHS = [
  'biome.json',
  '.gitignore',
  'mise.toml',
  'scripts/commit-title.ts',
  'src/ci/commit-title.ts',
  'scripts/boundaries.ts',
];
const VALIDATOR_PATTERNS = [/^tsconfig[^/]*\.json$/u];
/** Code that `task check` loads (a dynamic import at `src/cli/main.ts`). */
const TASK_CHECK_PREFIXES = ['src/task/', 'src/cli/'];
const TEST_PREFIXES = ['test/'];

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gu;
const DYNAMIC_IMPORT = /\bimport\s*\(/gu;
const SOURCE_FILE = /\.(?:mjs|js|ts)$/u;

export type GateManifest = {
  /** Entry points, then every file they import, relative to the root. */
  runner: string[];
  /** Files a runner in the closure loads by a dynamic import: the closure cannot see their targets. */
  dynamicImports: string[];
};

/** The import closure of the gate entry points under `root`, with the files that import dynamically. */
export function gateManifest(root: string): GateManifest {
  const seen = new Set<string>();
  const dynamic = new Set<string>();
  const queue = ENTRY_POINTS.map((entry) => resolve(root, entry));
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    if (!SOURCE_FILE.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    if (DYNAMIC_IMPORT.test(source)) dynamic.add(relative(root, file));
    DYNAMIC_IMPORT.lastIndex = 0;
    for (const [, specifier] of source.matchAll(IMPORT_SPECIFIER))
      queue.push(resolve(dirname(file), specifier ?? ''));
  }
  return {
    runner: [...seen].map((file) => relative(root, file)).sort(),
    dynamicImports: [...dynamic].sort(),
  };
}

export type FrameClass = 'runner' | 'validators' | 'taskCheck' | 'tests';

/** The class of a changed path: the producers of the verdict, or null. */
export function frameClass(
  path: string,
  manifest: Pick<GateManifest, 'runner'>,
): FrameClass | null {
  if (
    RUNNER_PATHS.includes(path) ||
    RUNNER_PREFIXES.some((p) => path.startsWith(p)) ||
    manifest.runner.includes(path)
  )
    return 'runner';
  if (
    VALIDATOR_PATHS.includes(path) ||
    VALIDATOR_PATTERNS.some((p) => p.test(path))
  )
    return 'validators';
  if (TASK_CHECK_PREFIXES.some((p) => path.startsWith(p))) return 'taskCheck';
  if (TEST_PREFIXES.some((p) => path.startsWith(p))) return 'tests';
  return null;
}

export type CommitTouch = { id: string; classes: FrameClass[] };

/** Parses `git log --first-parent --name-only --format=%x00%h` into the frame classes each commit touches. */
export function touches(
  log: string,
  manifest: Pick<GateManifest, 'runner'>,
): CommitTouch[] {
  const out: CommitTouch[] = [];
  for (const block of log.split('\0').slice(1)) {
    const [id = '', ...paths] = block.split('\n');
    const classes = new Set<FrameClass>();
    for (const path of paths) {
      const cls = path ? frameClass(path, manifest) : null;
      if (cls) classes.add(cls);
    }
    out.push({ id: id.trim(), classes: [...classes].sort() });
  }
  return out;
}

export type FrameCounts = {
  commits: number;
  /** Commits touching workflows, composite actions, package.json or the runner closure. */
  runner: number;
  /** The same, plus the validators and their configuration. */
  frame: number;
  /** The frame, plus `src/task` and `src/cli` behind `task check`. */
  withTaskCheck: number;
  /** Informational: commits touching a test. */
  tests: number;
};

export function countTouches(touched: CommitTouch[]): FrameCounts {
  const has = (t: CommitTouch, ...c: FrameClass[]) =>
    c.some((k) => t.classes.includes(k));
  return {
    commits: touched.length,
    runner: touched.filter((t) => has(t, 'runner')).length,
    frame: touched.filter((t) => has(t, 'runner', 'validators')).length,
    withTaskCheck: touched.filter((t) =>
      has(t, 'runner', 'validators', 'taskCheck'),
    ).length,
    tests: touched.filter((t) => has(t, 'tests')).length,
  };
}

export function gitLog(root: string, range: string): string {
  return execFileSync(
    'git',
    [
      '-C',
      root,
      'log',
      '--first-parent',
      '--name-only',
      '--format=%x00%h',
      range,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

export function renderManifest(
  manifest: GateManifest,
  touched: CommitTouch[],
): string {
  const counts = countTouches(touched);
  const lines = [
    'Frame (a change here can change the verdict):',
    `  workflows and composite actions: ${RUNNER_PREFIXES.join(' ')}`,
    `  package.json and runner closure (${manifest.runner.length} files): ${manifest.runner.join(' ')}`,
    `  validators and configuration: ${[...VALIDATOR_PATHS, 'tsconfig*.json'].join(' ')}`,
    'Content (the verdict reads it; a change is reviewed as code):',
    `  behind task check: ${TASK_CHECK_PREFIXES.join(' ')}`,
    `  tests: ${TEST_PREFIXES.join(' ')}`,
  ];
  if (manifest.dynamicImports.length)
    lines.push(
      `DYNAMIC IMPORT in the runner closure, its target is not in the frame: ${manifest.dynamicImports.join(' ')}`,
    );
  lines.push(
    `${counts.commits} commits: runner ${counts.runner}, frame ${counts.frame}, with task check ${counts.withTaskCheck}, tests ${counts.tests}`,
  );
  for (const t of touched)
    if (t.classes.some((c) => c !== 'tests'))
      lines.push(`  ${t.id} ${t.classes.join(' ')}`);
  return `${lines.join('\n')}\n`;
}

export type FrameChange = { path: string; class: FrameClass; lines: number };

/** The changed files of a pull request that sit in the frame or behind `task check`, with changed lines (tests are not listed). */
export function frameChanges(
  files: { path: string; lines: number }[],
  manifest: Pick<GateManifest, 'runner'>,
): FrameChange[] {
  const out: FrameChange[] = [];
  for (const file of files) {
    const cls = frameClass(file.path, manifest);
    if (cls && cls !== 'tests')
      out.push({ path: file.path, class: cls, lines: file.lines });
  }
  return out;
}
