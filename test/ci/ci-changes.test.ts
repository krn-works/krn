import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = join(root, 'scripts/ci-changes.mjs');

const sha = 'a'.repeat(40);

function detect(event: string, files?: string[], before?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-changes-'));
  const listing = join(directory, 'files');
  writeFileSync(listing, files ? `${files.join('\n')}\n` : '');
  const result = spawnSync(process.execPath, [script, listing], {
    cwd: root,
    env: { ...process.env, EVENT: event, BEFORE: before ?? '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('empty or unreadable diffs run tests', () => {
  assert.equal(detect('pull_request', []), 'test=true\n');
  assert.equal(detect('push', [], sha), 'test=true\n');
  assert.equal(detect('workflow_dispatch', ['tasks/t-a.json']), 'test=true\n');
});

test('task-only pushes skip tests', () => {
  assert.equal(detect('push', ['tasks/t-abc1234.json'], sha), 'test=false\n');
});

test('mixed pushes run tests', () => {
  assert.equal(
    detect('push', ['tasks/t-abc1234.json', 'src/cli/main.ts'], sha),
    'test=true\n',
  );
});

test('pushes without a usable before commit run tests', () => {
  for (const before of [undefined, '', '0'.repeat(40)])
    assert.equal(
      detect('push', ['tasks/t-abc1234.json'], before),
      'test=true\n',
      String(before),
    );
});

test('a detection error fails open', () => {
  const result = spawnSync(process.execPath, [script, '/nonexistent/listing'], {
    cwd: root,
    env: { ...process.env, EVENT: 'push', BEFORE: sha },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'test=true\n');
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
