import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const readerUsers = [
  'src/cli/ledger.ts',
  'src/evals/cli.ts',
  'src/evals/session.ts',
  'src/flow/cli.ts',
  'src/task/cli.ts',
  'src/worker/cli.ts',
];
// `!value || value.startsWith('--')` rejects free-text values such as `--note "--x"`.
const missingValueShape = /\|\|\s*[\w.[\]]+\.startsWith\(\s*['"`]--['"`]\s*\)/;

function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'src'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => /\.(?:[cm]?[jt]s)$/.test(path));
}

test('src has no startsWith("--") missing-value checks', () => {
  const offenders = sourceFiles().filter((path) =>
    missingValueShape.test(readFileSync(`${root}/${path}`, 'utf8')),
  );
  assert.deepEqual(
    offenders,
    [],
    'read flag values with src/cli/flag-value.ts',
  );
});

test('value-flag CLIs read values through the shared reader', () => {
  const bypassing = readerUsers.filter(
    (path) => !/\bflagValue\(/.test(readFileSync(`${root}/${path}`, 'utf8')),
  );
  assert.deepEqual(bypassing, []);
});

test('the missing-value shape matches the defect it guards', () => {
  assert.match("if (!value || value.startsWith('--'))", missingValueShape);
  assert.doesNotMatch(
    "id === undefined && !option.startsWith('--')",
    missingValueShape,
  );
});
