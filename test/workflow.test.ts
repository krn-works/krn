import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflowPath = new URL('../.github/workflows/ci.yml', import.meta.url);

test('CI workflow has one guarded gate job on the configured isolated runner', async () => {
  const source = await readFile(workflowPath, 'utf8');
  const lines = source.split(/\r?\n/u);
  const jobsIndex = lines.indexOf('jobs:');
  assert.notEqual(jobsIndex, -1, 'workflow must define jobs');

  const jobs: string[] = [];
  for (const line of lines.slice(jobsIndex + 1)) {
    if (/^\S/u.test(line)) break;
    const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/u);
    if (match) jobs.push(match[1] ?? '');
  }
  assert.deepEqual(jobs, ['gate']);

  const gateIndex = lines.indexOf('  gate:');
  assert.notEqual(gateIndex, -1, 'workflow must define the gate job');
  const gateLines: string[] = [];
  for (const line of lines.slice(gateIndex + 1)) {
    if (/^ {2}\S/u.test(line)) break;
    gateLines.push(line);
  }
  const scalar = (key: string): string | undefined => {
    const line = gateLines.find((candidate) =>
      candidate.startsWith(`    ${key}:`),
    );
    return line?.slice(line.indexOf(':') + 2);
  };

  assert.equal(scalar('name'), 'gate');
  assert.equal(
    scalar('if'),
    `\${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}`,
  );
  assert.equal(
    scalar('runs-on'),
    `\${{ fromJSON(vars.CI_RUNNER || '["self-hosted","linux","x64","krn-ci-isolated"]') }}`,
  );
});

test('CI workflow cancels superseded pull request runs but preserves main runs', async () => {
  const source = await readFile(workflowPath, 'utf8');
  const lines = source.split(/\r?\n/u);
  const concurrencyIndexes = lines.flatMap((line, index) =>
    line === 'concurrency:' ? [index] : [],
  );
  const jobsIndex = lines.indexOf('jobs:');

  assert.deepEqual(
    concurrencyIndexes.length,
    1,
    'workflow must define one top-level concurrency block',
  );
  assert.notEqual(jobsIndex, -1, 'workflow must define jobs');
  const concurrencyIndex = concurrencyIndexes[0];
  assert.ok(concurrencyIndex !== undefined && concurrencyIndex < jobsIndex);

  const entries = lines
    .slice(concurrencyIndex + 1, jobsIndex)
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^ {2}([a-z-]+): (.+)$/u);
      assert.ok(match, `unexpected top-level concurrency entry: ${line}`);
      return [match[1], match[2]];
    });

  assert.deepEqual(entries, [
    ['group', 'ci-${{ github.ref }}'],
    ['cancel-in-progress', "${{ github.ref != 'refs/heads/main' }}"],
  ]);

  const cancelExpression = entries[1]?.[1];
  const match = cancelExpression?.match(
    /^\$\{\{\s*github\.ref\s*!=\s*'([^']+)'\s*\}\}$/u,
  );
  assert.ok(
    match,
    'cancel-in-progress must compare github.ref with a protected ref',
  );
  const shouldCancel = (ref: string): boolean => ref !== match[1];

  assert.equal(shouldCancel('refs/heads/main'), false);
  assert.equal(shouldCancel('refs/pull/42/merge'), true);
});
