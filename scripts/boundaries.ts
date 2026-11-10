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
  fs: [],
  harness: [],
  outcome: ['harness'],
  state: [],
  deliver: [],
  ci: ['deliver'],
  adopt: ['task'],
  task: ['cli', 'fs'],
  evals: ['cli', 'hosts'],
  hosts: [],
  brain: ['cli', 'evals/fr40/tasks.ts'],
  cli: ['adopt', 'brain', 'ci', 'core', 'outcome', 'state', 'task'],
};

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
        to !== from &&
        !allowed.includes(to) &&
        !allowed.includes(target)
      )
        violations.push({ file: rel, line, specifier, edge });
    }
  }
  return violations;
}

export function main(root: string): number {
  const violations = check(root);
  for (const v of violations)
    process.stderr.write(
      `${v.file}:${v.line}: forbidden import ${v.edge} ('${v.specifier}')\n`,
    );
  if (violations.length > 0)
    process.stderr.write(
      `boundaries FAIL: ${violations.length} violation(s); layer map: scripts/boundaries.ts\n`,
    );
  return violations.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.cwd());
