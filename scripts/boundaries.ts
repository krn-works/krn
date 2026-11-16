// Import-boundary check for src/ (KRN-05). The layer map below is the single definition of "core" and its neighbours.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Allowed imports per src area (src/<dir>). An entry is another area name, a top-level directory as
 * `root:<dir>`, or an exact repo-relative file.
 * Core imports nothing. Mutual pairs (cli/task) are accepted couplings, not a rule.
 */
export const LAYERS: Readonly<Record<string, readonly string[]>> = {
  core: [],
  memory: ['harness'],
  context: ['harness', 'hook', 'memory', 'state'],
  successor: ['harness', 'memory', 'task', 'repo'],
  fs: [],
  harness: [],
  outcome: ['harness', 'repo', 'task'],
  state: [],
  deliver: ['repo'],
  ci: ['deliver', 'repo'],
  adopt: ['brain', 'harness', 'task', 'repo'],
  repo: [],
  'cli-kit': [],
  task: ['cli-kit', 'fs', 'repo'],
  evals: [],
  hook: ['brain', 'harness', 'repo', 'state', 'task'],
  dispatch: ['context', 'harness', 'hook', 'root:scripts'],
  brain: ['cli-kit', 'harness', 'repo'],
  cli: [
    'cli-kit',
    'harness',
    'adopt',
    'brain',
    'ci',
    'core',
    'dispatch',
    'outcome',
    'repo',
    'state',
    'task',
  ],
};

/**
 * Product is what an adopted repository runs; workshop is the operator's own delivery tooling (ADR 0017).
 * Product never imports workshop. `cli` is the verbs over both and `deliver`/`ci`/`evals`/`core` sit
 * outside the split until their ADR moves them. An exception is a `file -> workshop area` edge present
 * when the rule landed; the list may only shrink.
 */
export const PRODUCT: readonly string[] = [
  'task',
  'brain',
  'hook',
  'adopt',
  'repo',
  'harness',
];
export const WORKSHOP: readonly string[] = [
  'successor',
  'context',
  'state',
  'memory',
  'outcome',
];
export const PRODUCT_WORKSHOP_EXCEPTIONS: readonly string[] = [
  'src/hook/stop.ts -> state',
];

/**
 * A store is reached only through its owner: code outside the owner names the path through the
 * owner's helpers, never as a quoted literal.
 */
export const STORES: ReadonlyArray<{
  readonly name: string;
  readonly owner: string;
  readonly literal: RegExp;
}> = [
  { name: 'tasks/', owner: 'src/task/', literal: /(?<!\\)['"`]tasks\/(?!<)/u },
  {
    name: 'record files',
    owner: 'src/brain/',
    literal:
      /['"`](?:standards\/records\.json|\.agents\/(?:records|decisions)\.json|\.krn\/brain\/exposures\.jsonl)/u,
  },
];

export type Violation = {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly edge: string;
};

const SOURCE = /\.(?:ts|mts|mjs)$/u;
const STATIC =
  /^[ \t]*(?:import|export)\b(?:[^'";]*?\bfrom\s*)?\s*['"]([^'"]+)['"]/gmu;
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

/** Blank comments but keep newlines so match offsets still give the right line. */
function blank(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|(?<![:'"])\/\/[^\n]*/gu, (text) =>
    text.replace(/[^\n]/gu, ' '),
  );
}

export function specifiers(
  source: string,
): { specifier: string; line: number }[] {
  const code = blank(source);
  return [...code.matchAll(STATIC), ...code.matchAll(DYNAMIC)].map((match) => ({
    specifier: match[1] ?? '',
    line: code.slice(0, match.index).split('\n').length,
  }));
}

/** src/<dir> is area `<dir>`; any other top-level directory is `root:<dir>`, so `evals` never means `evals/`. */
function area(path: string): string {
  const [top = '', name] = path.split('/');
  return top === 'src' && name ? name : `root:${top}`;
}

/** Check every src file against the layer map; rel paths use `/`. A root without src/ has nothing to check. */
export function check(
  root: string,
  layers: Readonly<Record<string, readonly string[]>> = LAYERS,
): Violation[] {
  const violations: Violation[] = [];
  const source = join(root, 'src');
  for (const file of existsSync(source) ? walk(source) : []) {
    const rel = relative(root, file).split(sep).join('/');
    const from = area(rel);
    const allowed = layers[from];
    for (const { specifier, line } of specifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('node:') || !/^(?:\.|\/|file:)/u.test(specifier))
        continue;
      const target = relative(
        root,
        specifier.startsWith('file:')
          ? fileURLToPath(specifier)
          : resolve(dirname(file), specifier),
      )
        .split(sep)
        .join('/');
      const to = area(target);
      const edge = `${from} -> ${to}`;
      if (allowed === undefined)
        violations.push({
          file: rel,
          line,
          specifier,
          edge: `${edge} (area "${from}" missing from LAYERS)`,
        });
      else if (
        PRODUCT.includes(from) &&
        WORKSHOP.includes(to) &&
        !PRODUCT_WORKSHOP_EXCEPTIONS.includes(`${rel} -> ${to}`)
      )
        violations.push({
          file: rel,
          line,
          specifier,
          edge: `${edge} (product never imports workshop)`,
        });
      else if (
        to !== from &&
        !allowed.includes(to) &&
        !allowed.includes(target)
      )
        violations.push({ file: rel, line, specifier, edge });
    }
  }
  return violations;
}

/**
 * External binaries and the only src files that may name them as the command of a call. A new call
 * site must join an existing owner or add its file here, in review (a ratchet: the lists only shrink
 * unless review accepts a new owner). gh reads go through src/repo/gh.ts (ledger, window, adoption)
 * and src/deliver/transport.ts (delivery).
 */
export const BINARIES: Readonly<Record<string, readonly string[]>> = {
  gh: [
    'src/repo/gh.ts',
    'src/deliver/transport.ts',
    'src/cli/doctor-unattended.ts',
  ],
  herdr: ['src/successor/host-herdr.ts'],
  claude: [],
  bw: [],
  git: [
    'src/adopt/verify.ts',
    'evals/adoption/census.ts',
    'src/adopt/init.ts',
    'src/brain/exposures.ts',
    'src/brain/precedent.ts',
    'src/brain/standards-cli.ts',
    'src/brain/standards-review.ts',
    'src/brain/task-query.ts',
    'src/ci/conflict-check.ts',
    'src/ci/ship.ts',
    'src/cli/entry-pin.ts',
    'src/cli/lane-run/git.ts',
    'src/cli/lane-run/preflight.ts',
    'src/cli/lane-run/worktree.ts',
    'src/cli/lane.ts',
    'src/cli/outside-git.ts',
    'src/cli/pr-body.ts',
    'src/context/restart.ts',
    'src/harness/memory-directory.ts',
    'src/hook/edit-standards.ts',
    'src/hook/outcome-judge.ts',
    'src/hook/scope.ts',
    'src/hook/session-start.ts',
    'src/hook/stop.ts',
    'src/hook/unpushed-delete.ts',
    'src/memory/memory-refs.ts',
    'src/outcome/gate-manifest.ts',
    'src/outcome/ledger.ts',
    'src/outcome/rework-blame.ts',
    'src/outcome/window.ts',
    'src/repo/contract.ts',
    'src/state/git.ts',
    'src/successor/intent-to-task.ts',
    'src/task/branch-evidence.ts',
    'src/task/branch-tickets.ts',
    'src/task/claims.ts',
    'src/task/store.ts',
  ],
};

export type BinaryViolation = {
  readonly file: string;
  readonly line: number;
  readonly binary: string;
};

/** `(`, optional whitespace, then the quoted binary and a comma: the command argument of a call. */
const CALL = /\(\s*['"]([\w-]+)['"]\s*,/gu;

/** Calls that name a mapped binary from a file outside its owners. */
export function checkBinaries(
  root: string,
  binaries: Readonly<Record<string, readonly string[]>> = BINARIES,
): BinaryViolation[] {
  const violations: BinaryViolation[] = [];
  const source = join(root, 'src');
  for (const file of existsSync(source) ? walk(source) : []) {
    const rel = relative(root, file).split(sep).join('/');
    const code = blank(readFileSync(file, 'utf8'));
    for (const match of code.matchAll(CALL)) {
      const binary = match[1] ?? '';
      const owners = binaries[binary];
      if (owners === undefined || owners.includes(rel)) continue;
      violations.push({
        file: rel,
        line: code.slice(0, match.index).split('\n').length,
        binary,
      });
    }
  }
  return violations;
}

export type StoreViolation = {
  readonly file: string;
  readonly line: number;
  readonly store: string;
  readonly owner: string;
};

/** Quoted store paths in code (comments blanked) outside the store's owner. */
export function checkStores(root: string): StoreViolation[] {
  const source = join(root, 'src');
  const found: StoreViolation[] = [];
  for (const file of existsSync(source) ? walk(source) : []) {
    const rel = relative(root, file).split(sep).join('/');
    const code = blank(readFileSync(file, 'utf8'));
    for (const store of STORES) {
      if (rel.startsWith(store.owner)) continue;
      for (const match of code.matchAll(new RegExp(store.literal, 'gu')))
        found.push({
          file: rel,
          line: code.slice(0, match.index).split('\n').length,
          store: store.name,
          owner: store.owner,
        });
    }
  }
  return found;
}

export function main(root: string): number {
  const violations = check(root);
  const spawns = checkBinaries(root);
  const stores = checkStores(root);
  for (const v of stores)
    process.stderr.write(
      `${v.file}:${v.line}: names ${v.store} outside its owner ${v.owner} (STORES in scripts/boundaries.ts)\n`,
    );
  for (const v of spawns)
    process.stderr.write(
      `${v.file}:${v.line}: '${v.binary}' is called outside its owners (BINARIES in scripts/boundaries.ts)\n`,
    );
  for (const v of violations)
    process.stderr.write(
      `${v.file}:${v.line}: forbidden import ${v.edge} ('${v.specifier}')\n`,
    );
  const total = violations.length + spawns.length + stores.length;
  if (total > 0)
    process.stderr.write(
      `boundaries FAIL: ${total} violation(s); layer map and binary owners: scripts/boundaries.ts\n`,
    );
  return total === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.cwd());
