import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = join(root, 'scripts/ci-changes.mjs');
const isolationFile = 'test/evals/session.test.ts';

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

test('pushes and empty or unreadable diffs run every job', () => {
  assert.equal(detect('push', ['docs/x.md']), 'test=true\nisolation=true\n');
  assert.equal(detect('pull_request', []), 'test=true\nisolation=true\n');
});

test('task-only pull requests skip tests', () => {
  assert.equal(
    detect('pull_request', ['tasks/t-abc1234.json']),
    'test=false\nisolation=false\n',
  );
});

test('documents and non-isolation tests skip only the isolation setup', () => {
  assert.equal(
    detect('pull_request', [
      'docs/program/PLAN.md',
      'README.md',
      'tasks/t-abc1234.json',
      'test/workflow.test.ts',
    ]),
    'test=true\nisolation=false\n',
  );
});

test('source, agent instructions, helpers and isolation tests run isolation', () => {
  for (const file of [
    'src/cli/main.ts',
    'AGENTS.md',
    'CLAUDE.md',
    'docs/AGENTS.md',
    'docs/program/CLAUDE.md',
    'test/helpers/isolation.ts',
    isolationFile,
    '.github/workflows/ci.yml',
    'package.json',
    'tasks/nested/t-x.json',
  ])
    assert.equal(
      detect('pull_request', ['docs/x.md', file]),
      'test=true\nisolation=true\n',
      file,
    );
});

test('the isolation test fixture used here is still an isolation file', async () => {
  const { selectIsolationTestFiles } = await import(
    '../../scripts/isolation-gate.mjs'
  );
  assert.ok(
    selectIsolationTestFiles(root, 'test/**/*.test.{ts,js,mjs,cjs}').includes(
      isolationFile,
    ),
  );
});
