// Claude Code specifics live behind src/harness/claude.ts: outside src/harness no string literal names
// the `.claude` directory or the `claude` binary, so a second harness replaces one module, not ten.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** The text of every string and template literal in `source`, comments skipped. */
function stringLiterals(source: string): string[] {
  const found: string[] = [];
  // Each open template, with the brace depth of its code inside `${...}`.
  const templates: number[] = [];
  let i = 0;
  const readTemplate = () => {
    let text = '';
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') {
        text += source.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        i++;
        templates.pop();
        break;
      } else if (c === '$' && source[i + 1] === '{') {
        i += 2;
        templates[templates.length - 1] = 1;
        break;
      } else {
        text += c;
        i++;
      }
    }
    found.push(text);
  };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    const open = templates.length > 0 && templates.at(-1) !== 0;
    if (c === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === '/' && next === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 2;
    } else if (c === "'" || c === '"') {
      let text = '';
      i++;
      while (i < source.length && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') text += source[i++];
        text += source[i++];
      }
      i++;
      found.push(text);
    } else if (c === '`') {
      i++;
      templates.push(0);
      readTemplate();
    } else if (open && c === '{') {
      templates[templates.length - 1] = (templates.at(-1) ?? 0) + 1;
      i++;
    } else if (open && c === '}') {
      const depth = (templates.at(-1) ?? 1) - 1;
      templates[templates.length - 1] = depth;
      i++;
      if (depth === 0) readTemplate();
    } else i++;
  }
  return found;
}

/** A literal that names the Claude Code directory as a path segment, or is the bare binary name. */
function namesClaude(literal: string): boolean {
  return literal === 'claude' || /(^|[/\\~])\.claude(\b|$)/u.test(literal);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

test('the scanner reads string and template literals and skips comments', () => {
  const source = [
    "// '.claude' in a comment",
    '/* `claude` in a block */',
    "const a = '.claude/settings.json';",
    'const b = "claude";',
    'const c = `${x ? `.claude` : y} tail`;',
    "const d = `${{ k: 'v' }.k} after`;",
  ].join('\n');
  const literals = stringLiterals(source);
  assert.deepEqual(literals.filter(namesClaude), [
    '.claude/settings.json',
    'claude',
    '.claude',
  ]);
  assert.ok(literals.includes(' after'));
});

test('Claude Code literals appear only under src/harness', () => {
  const offenders = sourceFiles(join(root, 'src'))
    .filter((path) => !relative(root, path).startsWith(join('src', 'harness')))
    .flatMap((path) =>
      stringLiterals(readFileSync(path, 'utf8'))
        .filter(namesClaude)
        .map((literal) => `${relative(root, path)}: ${literal}`),
    );
  assert.deepEqual(
    offenders,
    [],
    'name these through src/harness/claude.ts (claudeAgent, claudeDir, projectPath, configHome)',
  );
});
