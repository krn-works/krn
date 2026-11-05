import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

interface VerifyLine {
  readonly step: string;
  readonly status: string;
  readonly detail: string;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  logPath: string,
) => { readonly exitCode: number | null };

type RunVerify = (
  options: { readonly base: string; readonly skipped?: readonly string[] },
  dependencies: { readonly cwd: string; readonly commandRunner: CommandRunner },
) => Promise<{ readonly lines: readonly VerifyLine[] }>;

// Verbatim `npm run lint` output of biome 2.5.15 over a project whose
// test/observer.test.js has three errors and one warning, and whose unchanged
// src/other.ts and biome.json also have errors.
const capture = {
  output:
    '\n> lint\n> biome check .\n\ntest/observer.test.js:2:1 lint/style/useConst  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n  ! This let declares a variable that is only assigned once.\n  \n    1 │ const a = /\\x00/;\n  > 2 │ let b = 1;\n      │ ^^^\n    3 │ export { a, b };\n    4 │ const c  = 2;\n  \n  i \'b\' is never reassigned.\n  \n    1 │ const a = /\\x00/;\n  > 2 │ let b = 1;\n      │     ^\n    3 │ export { a, b };\n    4 │ const c  = 2;\n  \n  i Safe fix: Use const instead.\n  \n    1 1 │   const a = /\\x00/;\n    2   │ - let·b·=·1;\n      2 │ + const·b·=·1;\n    3 3 │   export { a, b };\n    4 4 │   const c  = 2;\n  \n\nbiome.json format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n  × Formatter would have printed the following content:\n  \n    1 │ {·"files":·{·"includes":·["src/**",·"test/**"]·}·}\n      │  +        + +           +          +          + + \n\nsrc/other.ts:1:19 lint/suspicious/noControlCharactersInRegex ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n  × Unexpected control character in a regular expression.\n  \n  > 1 │ export const d = /\\x01/;\n      │                   ^^^^\n    2 │ \n  \n  i Control characters are unusual and potentially incorrect inputs, so they are disallowed.\n  \n\ntest/observer.test.js:1:12 lint/suspicious/noControlCharactersInRegex ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n  × Unexpected control character in a regular expression.\n  \n  > 1 │ const a = /\\x00/;\n      │            ^^^^\n    2 │ let b = 1;\n    3 │ export { a, b };\n  \n  i Control characters are unusual and potentially incorrect inputs, so they are disallowed.\n  \n\ntest/observer.test.js:3:1 assist/source/organizeImports  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n  × Some imports or exports are not organized.\n  \n    1 │ const a = /\\x00/;\n    2 │ let b = 1;\n  > 3 │ export { a, b };\n      │ ^^^^^^^^^^^^^^^^\n  > 4 │ const c  = 2;\n  > 5 │ export { c };\n      │ ^^^^^^^^^^^^^\n    6 │ \n  \n  i This statement must be preceded by a blank line. Add a newline before this statement.\n  \n    1 │ const a = /\\x00/;\n    2 │ let b = 1;\n  > 3 │ export { a, b };\n      │ ^^^^^^^^^^^^^^^^\n    4 │ const c  = 2;\n    5 │ export { c };\n  \n  i This statement must be preceded by a blank line. Add a newline before this statement.\n  \n    2 │ let b = 1;\n    3 │ export { a, b };\n  > 4 │ const c  = 2;\n      │ ^^^^^^^^^^^^^\n    5 │ export { c };\n    6 │ \n  \n  i This statement must be preceded by a blank line. Add a newline before this statement.\n  \n    3 │ export { a, b };\n    4 │ const c  = 2;\n  > 5 │ export { c };\n      │ ^^^^^^^^^^^^^\n    6 │ \n  \n  i Safe fix: Organize imports and exports (Biome)\n  \n    1 1 │   const a = /\\x00/;\n    2 2 │   let b = 1;\n      3 │ + \n    3 4 │   export { a, b };\n      5 │ + \n    4 6 │   const c  = 2;\n      7 │ + \n    5 8 │   export { c };\n    6 9 │   \n  \n\ntest/observer.test.js format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n  × Formatter would have printed the following content:\n  \n    2 2 │   let b = 1;\n    3 3 │   export { a, b };\n    4   │ - const·c··=·2;\n      4 │ + const·c·=·2;\n    5 5 │   export { c };\n    6 6 │   \n  \n\nChecked 3 files in 5ms. No fixes applied.\nFound 5 errors.\nFound 1 warning.\ncheck ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n  × Some errors were emitted while running checks.\n  \n\n',
};

async function loadRunVerify(): Promise<RunVerify> {
  const imported: unknown = await import('../../src/verify/index.ts');
  const runVerify =
    typeof imported === 'object' && imported !== null
      ? Reflect.get(imported, 'runVerify')
      : undefined;
  assert.equal(typeof runVerify, 'function', 'runVerify must be exported');
  return runVerify as RunVerify;
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function withRepository(
  body: (root: string, base: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'krn-verify-lint-'));
  try {
    const root = join(directory, 'repo');
    await mkdir(join(root, 'test'), { recursive: true });
    await mkdir(join(root, 'src'));
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.name', 'Verify Test']);
    git(root, ['config', 'user.email', 'verify@example.test']);
    await writeFile(join(root, 'package.json'), '{}\n');
    await writeFile(join(root, 'src/other.ts'), 'export {};\n');
    await writeFile(join(root, 'test/observer.test.js'), '// base\n');
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'base']);
    const base = git(root, ['rev-parse', 'HEAD']);
    await writeFile(join(root, 'test/observer.test.js'), '// head\n');
    git(root, ['commit', '--quiet', '-am', 'head']);
    await body(root, base);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function lintRunner(output: string, exitCode: number): CommandRunner {
  return (command, args, _cwd, logPath) => {
    const lint = command === 'npm' && args[1] === 'lint';
    writeFileSync(logPath, lint ? output : 'ok\n');
    return { exitCode: lint ? exitCode : 0 };
  };
}

function lintLines(lines: readonly VerifyLine[]): string[] {
  return lines
    .filter(({ step }) => step === 'lint')
    .map(({ status, detail }) => `${status} ${detail}`);
}

test('a failing lint names each biome error in a changed path and the fix command', async () => {
  const runVerify = await loadRunVerify();
  await withRepository(async (root, base) => {
    const result = await runVerify(
      { base, skipped: ['red-first'] },
      { cwd: root, commandRunner: lintRunner(capture.output, 1) },
    );
    const lines = lintLines(result.lines);
    assert.match(lines[0] ?? '', /^FAIL exit=1 log=\.krn\/tmp\/verify-/u);
    assert.deepEqual(lines.slice(1), [
      'FAIL error test/observer.test.js:1:12 lint/suspicious/noControlCharactersInRegex',
      'FAIL error test/observer.test.js:3:1 assist/source/organizeImports',
      'FAIL error test/observer.test.js format',
      'FAIL fix npx biome check --write test/observer.test.js',
    ]);
    const steps = result.lines.map(({ step }) => step);
    assert.deepEqual(
      [...new Set(steps)],
      [
        'lint',
        'check',
        'targeted',
        'red-first',
        'preflight',
        'diff-check',
        'tickets',
        'overall',
      ],
    );
  });
});

test('a failing lint without errors in changed paths prints only its log line', async () => {
  const runVerify = await loadRunVerify();
  await withRepository(async (root, base) => {
    const unchangedOnly = capture.output
      .split('\n')
      .map((entry) => entry.replaceAll('test/observer.test.js', 'test/kept.js'))
      .join('\n');
    const result = await runVerify(
      { base, skipped: ['red-first'] },
      { cwd: root, commandRunner: lintRunner(unchangedOnly, 1) },
    );
    assert.equal(lintLines(result.lines).length, 1);
  });
});

test('a CRLF log names the same errors and unsafe header text is never printed', async () => {
  const runVerify = await loadRunVerify();
  await withRepository(async (root, base) => {
    const crlf = await runVerify(
      { base, skipped: ['red-first'] },
      {
        cwd: root,
        commandRunner: lintRunner(capture.output.replaceAll('\n', '\r\n'), 1),
      },
    );
    assert.equal(lintLines(crlf.lines).length, 5);
    const unsafe = [
      'test/observer.test.js:1:1 lint/a\u200bb ━━━━',
      '',
      '  × format character in the category',
      'test/observer.test.js:1:1 lint/a\u0007b ━━━━',
      '',
      '  × control character in the category',
      'test/observer.test.js\u2028x:1:1 lint/c ━━━━',
      '',
      '  × line separator in the path',
    ].join('\n');
    const result = await runVerify(
      { base, skipped: ['red-first'] },
      { cwd: root, commandRunner: lintRunner(unsafe, 1) },
    );
    assert.equal(lintLines(result.lines).length, 1);
  });
});

test('a changed path with a colon or shell metacharacters is named and quoted', async () => {
  const runVerify = await loadRunVerify();
  const odd = "test/a:b;touch$IFS'x'.js";
  await withRepository(async (root, base) => {
    await writeFile(join(root, odd), '// head\n');
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'odd path']);
    const log = [
      `${odd}:4:2 lint/suspicious/noDebugger  FIXABLE  ━━━━`,
      '',
      '  × This is an unexpected use of the debugger statement.',
      `${odd} format ━━━━`,
      '',
      '  × Formatter would have printed the following content:',
    ].join('\n');
    const result = await runVerify(
      { base, skipped: ['red-first'] },
      { cwd: root, commandRunner: lintRunner(log, 1) },
    );
    assert.deepEqual(lintLines(result.lines).slice(1), [
      `FAIL error ${odd}:4:2 lint/suspicious/noDebugger`,
      `FAIL error ${odd} format`,
      "FAIL fix npx biome check --write 'test/a:b;touch$IFS'\\''x'\\''.js'",
    ]);
  });
});

test('a passing lint prints one line even when its log names diagnostics', async () => {
  const runVerify = await loadRunVerify();
  await withRepository(async (root, base) => {
    const result = await runVerify(
      { base, skipped: ['red-first'] },
      { cwd: root, commandRunner: lintRunner(capture.output, 0) },
    );
    assert.deepEqual(lintLines(result.lines), ['PASS completed']);
  });
});
