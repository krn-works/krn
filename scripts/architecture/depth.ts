// Measured depth check: per-module interface width, size, and coupling for src/. Skill: architecture.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Flag = 'pass-through' | 'shallow' | 'hub' | 'types-only';

export type ModuleDepth = {
  readonly path: string;
  readonly exports: number;
  readonly lines: number;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly flags: readonly Flag[];
  readonly score: number;
};

const SHALLOW_LINES_PER_EXPORT = 25;
const SHALLOW_MIN_EXPORTS = 5;
const HUB_MIN_LINES = 800;
const HUB_MIN_COUPLING = 15;

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
      ? [path]
      : [];
  });
}

function strip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
}

function runtimeExports(code: string): number {
  return [
    ...code.matchAll(
      /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|abstract\s+class|enum)\s+\w+/gmu,
    ),
  ].length;
}

function exportedSymbols(code: string): number {
  let count = 0;
  count += [
    ...code.matchAll(
      /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|abstract\s+class|type|interface|enum)\s+\w+/gmu,
    ),
  ].length;
  if (/^export\s+default\b/mu.test(code)) count += 1;
  for (const match of code.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gmu))
    count += (match[1] ?? '').split(',').filter((s) => s.trim()).length;
  // `export * from` re-exports an unbounded surface; count it as one symbol per statement.
  count += [...code.matchAll(/^export\s+\*(?:\s+as\s+\w+)?\s+from\b/gmu)]
    .length;
  return count;
}

function specifiers(code: string): string[] {
  return [
    ...code.matchAll(
      /(?:^|[\s;])(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gu,
    ),
    ...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ]
    .map((m) => m[1] ?? '')
    .filter((s) => s.startsWith('.'));
}

function passThrough(code: string): boolean {
  const statements = code
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const joined = statements.join(' ');
  const rest = joined
    .replace(
      /export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"][^'"]+['"];?/gu,
      '',
    )
    .replace(/import\s+[^;]*?from\s+['"][^'"]+['"];?/gu, '')
    .trim();
  return rest === '' && /export\s/u.test(joined);
}

export function analyze(
  srcRoot: string,
  extraRoots: readonly string[] = [],
): ModuleDepth[] {
  const files = walk(srcRoot);
  const known = new Set(files);
  const fanIn = new Map<string, number>(files.map((f) => [f, 0]));
  const rows = files.map((file) => {
    const code = strip(readFileSync(file, 'utf8'));
    const targets = new Set(
      specifiers(code)
        .map((s) => resolve(dirname(file), s))
        .flatMap((p) => [p, `${p}.ts`, join(p, 'index.ts')])
        .filter((p) => known.has(p) && p !== file),
    );
    for (const t of targets) fanIn.set(t, (fanIn.get(t) ?? 0) + 1);
    return {
      file,
      code,
      fanOut: targets.size,
      lines: code.split('\n').filter((l) => l.trim() !== '').length,
    };
  });
  // Callers outside src (tests, scripts) also depend on the interface.
  for (const root of extraRoots) {
    for (const file of walk(root)) {
      const targets = new Set(
        specifiers(strip(readFileSync(file, 'utf8')))
          .map((s) => resolve(dirname(file), s))
          .flatMap((p) => [p, `${p}.ts`, join(p, 'index.ts')])
          .filter((p) => known.has(p)),
      );
      for (const t of targets) fanIn.set(t, (fanIn.get(t) ?? 0) + 1);
    }
  }
  return rows
    .map(({ file, code, fanOut, lines }) => {
      const exports = exportedSymbols(code);
      const flags: Flag[] = [];
      const inbound = fanIn.get(file) ?? 0;
      if (passThrough(code)) flags.push('pass-through');
      else if (runtimeExports(code) === 0 && exports > 0)
        flags.push('types-only');
      else if (
        exports >= SHALLOW_MIN_EXPORTS &&
        lines / exports < SHALLOW_LINES_PER_EXPORT
      )
        flags.push('shallow');
      if (lines >= HUB_MIN_LINES && fanOut + inbound >= HUB_MIN_COUPLING)
        flags.push('hub');
      const score = flags.includes('hub')
        ? Math.round((lines / 100) * ((fanOut + inbound) / 10) * 10) / 10
        : flags.length === 0 || flags.includes('types-only')
          ? 0
          : Math.round(exports * Math.max(1, inbound) * 10) / 10;
      return {
        path: relative(dirname(srcRoot), file),
        exports,
        lines,
        fanIn: inbound,
        fanOut,
        flags,
        score,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function report(modules: readonly ModuleDepth[], top = 10): string {
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  const lines = [
    `${'module'.padEnd(44)} ${pad('exp', 4)} ${pad('lines', 6)} ${pad('in', 4)} ${pad('out', 4)}  flags`,
    ...modules.map(
      (m) =>
        `${m.path.padEnd(44)} ${pad(m.exports, 4)} ${pad(m.lines, 6)} ${pad(m.fanIn, 4)} ${pad(m.fanOut, 4)}  ${m.flags.join(',')}`,
    ),
  ];
  const flagged = modules
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  lines.push(
    '',
    'deepening candidates (score = exports x importers; hub = lines x coupling; types-only is vocabulary, not a candidate)',
  );
  for (const m of flagged.slice(0, top))
    lines.push(`  ${pad(m.score, 7)}  ${m.path}  [${m.flags.join(',')}]`);
  const kinds = (flag: Flag) =>
    modules.filter((m) => m.flags.includes(flag)).length;
  lines.push(
    '',
    `verdict: ${modules.length} modules, ${kinds('pass-through')} pass-through, ${kinds('shallow')} shallow, ${kinds('hub')} hub, ${kinds('types-only')} types-only; top candidate ${flagged[0]?.path ?? 'none'}`,
  );
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const srcRoot = resolve(process.argv[2] ?? join(root, 'src'));
  console.log(
    report(analyze(srcRoot, [join(root, 'test'), join(root, 'scripts')])),
  );
}
