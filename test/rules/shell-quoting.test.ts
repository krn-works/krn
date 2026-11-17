// A command wrapped as `sh -c ${JSON.stringify(cmd)}` is still expanded by the outer shell: `$x`, `$?` and
// `$(...)` stay live inside double quotes. Quote text for a shell with `shellWord` from src/repo/shell-text.ts.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** A shell invoked with -c whose command word is a template `${JSON.stringify(...)}`. */
const jsonQuotedShell =
  /\b(?:ba|z|da|k)?sh\s+(?:-[a-z]+\s+)*-[a-z]*c\s+\\?["']?\$\{\s*JSON\.stringify\(/u;

/** The lines of `source` that use JSON.stringify as shell quoting. */
function jsonQuotedShellLines(source: string): number[] {
  return source
    .split('\n')
    .flatMap((line, index) => (jsonQuotedShell.test(line) ? [index + 1] : []));
}

const message =
  'quote shell text with shellWord from src/repo/shell-text.ts, not JSON.stringify';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|mjs)$/u.test(entry.name) ? [path] : [];
  });
}

test('the check refuses sh -c with JSON.stringify as the quoting', () => {
  const fixtures = [
    'const run = `sh -c ${JSON.stringify(cmd)}`;',
    'exec(`bash -c "${JSON.stringify(cmd)}"`);',
    'exec(`/bin/sh -lc ${JSON.stringify(cmd)} 2>&1`);',
  ];
  for (const fixture of fixtures) {
    assert.deepEqual(jsonQuotedShellLines(fixture), [1], fixture);
  }
});

test('the check accepts shellWord and argv arrays', () => {
  const clean = [
    'const run = `sh -c ${shellWord(cmd)}`;',
    "spawn('sh', ['-c', JSON.stringify(cmd)]);",
    'const body = JSON.stringify(payload);',
  ].join('\n');
  assert.deepEqual(jsonQuotedShellLines(clean), []);
});

test('no TypeScript or module source quotes shell text with JSON.stringify', () => {
  const offenders = ['src', 'scripts', 'evals', 'test', 'bin']
    .flatMap((dir) => {
      try {
        return sourceFiles(join(root, dir));
      } catch {
        return [];
      }
    })
    .filter(
      (path) =>
        relative(root, path) !== join('test', 'rules', 'shell-quoting.test.ts'),
    )
    .flatMap((path) =>
      jsonQuotedShellLines(readFileSync(path, 'utf8')).map(
        (line) => `${relative(root, path)}:${line}`,
      ),
    );
  assert.deepEqual(offenders, [], message);
});
