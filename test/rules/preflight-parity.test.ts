import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as suite from '../../scripts/test-suite.mjs';

const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
type Select = (args: string[], projectRoot?: string) => string[];

function preflightTestArguments(): string[] {
  const manifest: unknown = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  const script = (manifest as { scripts?: { preflight?: unknown } }).scripts
    ?.preflight;
  assert.equal(typeof script, 'string', 'package.json has a preflight script');
  const commands = (script as string)
    .split('&&')
    .map((command) => command.trim())
    .filter((command) => command.startsWith('npm test -- '));
  const [command] = commands;
  assert.ok(
    command !== undefined && commands.length === 1,
    'preflight runs one npm test command',
  );
  return command.slice('npm test -- '.length).split(/\s+/u);
}

function selector(): Select {
  const select: unknown = (suite as Record<string, unknown>).selectTestFiles;
  assert.equal(
    typeof select,
    'function',
    'scripts/test-suite.mjs exports selectTestFiles',
  );
  return select as Select;
}

function fromRoot(projectRoot: string, files: string[]): string[] {
  return files.map((file) => relative(projectRoot, file).split(sep).join('/'));
}

test('preflight passes test paths, not shell globs', () => {
  assert.deepEqual(
    preflightTestArguments().filter((argument) => /[*?[\]{}]/u.test(argument)),
    [],
    'sh would expand these with a grammar other than TEST_FILE_GLOB',
  );
});

test('preflight runs every file CI runs under test/rules and nothing CI skips', () => {
  const select = selector();
  const ci = fromRoot(root, select([], root));
  const ciRules = ci.filter((file) => file.startsWith('test/rules/'));
  assert.ok(ciRules.includes('test/rules/host-path-guard.test.mjs'));
  const preflight = fromRoot(root, select(preflightTestArguments(), root));
  assert.deepEqual(
    ciRules.filter((file) => !preflight.includes(file)),
    [],
    'CI-only rule tests',
  );
  assert.deepEqual(
    preflight.filter((file) => !ci.includes(file)),
    [],
    'preflight-only files',
  );
});

test('a directory argument selects exactly what TEST_FILE_GLOB discovers under it', (t) => {
  const select = selector();
  const project = realpathSync(
    mkdtempSync(join(tmpdir(), 'krn-preflight-parity-')),
  );
  t.after(() => rmSync(project, { recursive: true, force: true }));
  for (const file of [
    'test/rules/a.test.ts',
    'test/rules/b.test.mjs',
    'test/rules/c.test.js',
    'test/rules/nested/d.test.cjs',
    'test/rules/helper.ts',
    'test/rules/fixture.test.json',
    'test/other.test.ts',
    'test/empty/helper.ts',
    'src/main.ts',
  ]) {
    mkdirSync(dirname(join(project, file)), { recursive: true });
    writeFileSync(join(project, file), '');
  }
  const rules = [
    'test/rules/a.test.ts',
    'test/rules/b.test.mjs',
    'test/rules/c.test.js',
    'test/rules/nested/d.test.cjs',
  ];
  assert.deepEqual(fromRoot(project, select(['test/rules'], project)), rules);
  assert.deepEqual(fromRoot(project, select(['test/rules/'], project)), rules);
  assert.deepEqual(
    fromRoot(project, select(['test/rules/a.test.ts', 'test/rules'], project)),
    rules,
  );
  assert.deepEqual(
    fromRoot(project, select(['test'], project)),
    [...rules, 'test/other.test.ts'].sort(),
  );
  assert.throws(
    () => select(['test/empty'], project),
    /test directory holds no project test files/u,
  );
  const outside = realpathSync(
    mkdtempSync(join(tmpdir(), 'krn-preflight-outside-')),
  );
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'escape.test.ts'), '');
  symlinkSync(outside, join(project, 'src/linked'), 'dir');
  for (const directory of ['', '.', '..', 'src', 'src/linked', outside])
    assert.throws(
      () => select([directory], project),
      /must be the project test root or inside it/u,
      JSON.stringify(directory),
    );
  assert.throws(
    () => select(['--watch'], project),
    /accepts file or directory paths only/u,
  );
  assert.throws(() => select(['test/missing'], project), /ENOENT/u);
  assert.throws(
    () => select(['/dev/null'], project),
    /not a file or directory/u,
  );
  assert.throws(
    () => select([`test/${'x'.repeat(4096)}`], project),
    /test argument exceeds 4096 bytes/u,
  );
  symlinkSync(outside, join(project, 'test/linked'), 'dir');
  assert.throws(
    () => select(['test/linked'], project),
    /must be the project test root or inside it|resolved outside project test root/u,
  );
});
