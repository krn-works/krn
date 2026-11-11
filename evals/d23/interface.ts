// The interface paragraph a replayed task gets: which modules and exported names the hidden acceptance
// tests import, SWE-bench Pro style. It names the seam the tests call, never the test bodies, so an arm
// is graded on behavior instead of on guessing the original pull request's identifiers.
// Usage: node evals/d23/interface.ts --grades <regrade dir> --out <dir>  (writes <out>/<pr>.txt)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TestImport {
  module: string;
  names: string[];
}

/** Relative imports of non-test modules in one test file, resolved against the repository root. */
export function testImports(testPath: string, source: string): TestImport[] {
  const found = new Map<string, Set<string>>();
  const re =
    /import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+\w+)?\s*from\s*['"](\.[^'"]+)['"]/g;
  for (const m of source.matchAll(re)) {
    const spec = m[3] ?? '';
    if (/\.test\.|\/fixtures?\//.test(spec)) continue;
    const module = normalize(join(dirname(testPath), spec));
    const names = found.get(module) ?? new Set<string>();
    if (m[1]) names.add('default');
    for (const raw of (m[2] ?? '').split(',')) {
      const name = raw
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.add(name);
    }
    found.set(module, names);
  }
  // Scripts the test runs or imports dynamically: any quoted relative code path, such as
  // `new URL('../../scripts/x.ts', import.meta.url)` or `const path = '../../src/x.ts'`.
  const urls = [
    ...source.matchAll(/(?<!from\s*)['"](\.\.?\/[^'"\s]+\.(?:ts|mjs|js))['"]/g),
  ]
    .map((m) => m[1] ?? '')
    .filter((spec) => !/\.test\.|\/fixtures?\//.test(spec))
    .map((spec) => normalize(join(dirname(testPath), spec)))
    .filter((module, i, all) => all.indexOf(module) === i);
  // Members called on a dynamically imported namespace (`const m = await import(p)` then `m.name(`).
  const dynamic = new Set<string>();
  for (const bind of source.matchAll(/const\s+(\w+)\s*=\s*await\s+import\(/g)) {
    for (const use of source.matchAll(new RegExp(`(?<![\\w/.-])${bind[1]}\\??\\.(\\w+)`, 'g')))
      if (use[1]) dynamic.add(use[1]);
  }
  for (const module of urls) {
    const names = found.get(module) ?? new Set<string>();
    if (urls.length === 1) for (const n of dynamic) names.add(n);
    found.set(module, names);
  }
  return [...found].map(([module, names]) => ({
    module,
    names: [...names].sort(),
  }));
}

export function interfaceParagraph(imports: TestImport[]): string {
  if (imports.length === 0) return '';
  const lines = imports.map((i) =>
    i.names.length > 0
      ? `- \`${i.module}\` exports ${i.names.map((n) => `\`${n}\``).join(', ')}`
      : `- \`${i.module}\` (the tests run or import this file)`,
  );
  return `\n\nInterface the acceptance tests use (keep these module paths and export names):\n${lines.join('\n')}\n`;
}

function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i > 0 ? process.argv[i + 1] : undefined;
    if (!v) throw new Error(`--${name} is required`);
    return v;
  };
  const grades = arg('grades');
  const out = arg('out');
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(grades).filter((n) => /^\d+\.json$/.test(n))) {
    const g = JSON.parse(readFileSync(join(grades, f), 'utf8')) as {
      pr: string;
      merge: string;
      failToPass: string[];
    };
    const merged = new Map<string, Set<string>>();
    for (const t of g.failToPass) {
      const src = execFileSync('git', ['show', `${g.merge}:${t}`], {
        cwd: repo,
        encoding: 'utf8',
      });
      for (const i of testImports(t, src)) {
        const s = merged.get(i.module) ?? new Set<string>();
        for (const n of i.names) s.add(n);
        merged.set(i.module, s);
      }
    }
    const imports = [...merged].map(([module, names]) => ({
      module,
      names: [...names].sort(),
    }));
    writeFileSync(join(out, `${g.pr}.txt`), interfaceParagraph(imports));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
