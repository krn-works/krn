import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const phaseOrSliceToken =
  /(?:^|[/._-])(?:s\d+[a-z]?|j\d+|r\d+|f\d+(?:s\d+)?|n\d+|l\d+|b\d+|LON-\d+)(?=$|[/._-])/iu;

function forbiddenPaths(paths) {
  return paths.filter((path) => phaseOrSliceToken.test(path)).sort();
}

function trackedCodePaths() {
  const revision = process.env.KRN_PATH_GUARD_REVISION;
  const args = revision
    ? [
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        revision,
        '--',
        'scripts',
        'src',
        'test',
      ]
    : ['ls-files', '-z', '--', 'scripts', 'src', 'test'];
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

test('tracked code, test, and script paths have no phase or slice tokens', () => {
  assert.deepEqual(forbiddenPaths(trackedCodePaths()), []);
});

test('rejects phase-code filename mutants across each listed token family', () => {
  const mutants = [
    'test/s9x-foo.test.ts',
    'test/j9-foo.test.ts',
    'test/r9-foo.test.ts',
    'test/f9s2-foo.test.ts',
    'test/n9-foo.test.ts',
    'test/l9-foo.test.ts',
    'test/LON-319-foo.test.ts',
    'test/b954-foo.test.ts',
  ];

  assert.deepEqual(forbiddenPaths(mutants), [...mutants].sort());
});

test('does not treat e2e, utf8, or rust version strings as phase tokens', () => {
  assert.deepEqual(
    forbiddenPaths([
      'test/e2e/delivery.test.ts',
      'src/encoding/utf8-decoder.ts',
      'test/fixtures/codex/rust-v0.162.1.jsonl',
    ]),
    [],
  );
});
