import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = join(root, 'scripts/ci-changes.mjs');

function detect(event: string, files?: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-changes-'));
  const listing = join(directory, 'files');
  writeFileSync(listing, files ? `${files.join('\n')}\n` : '');
  const result = spawnSync(process.execPath, [script, listing], {
    cwd: root,
    env: { ...process.env, EVENT: event },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('pushes and empty or unreadable diffs run tests', () => {
  assert.equal(detect('push', ['tasks/t-abc1234.json']), 'test=true\n');
  assert.equal(detect('pull_request', []), 'test=true\n');
});

test('task-only pull requests skip tests', () => {
  assert.equal(
    detect('pull_request', ['tasks/t-abc1234.json']),
    'test=false\n',
  );
});

test('any other changed file runs tests', () => {
  for (const file of ['src/cli/main.ts', 'docs/x.md', 'tasks/nested/t-x.json'])
    assert.equal(
      detect('pull_request', ['tasks/t-abc1234.json', file]),
      'test=true\n',
      file,
    );
});
