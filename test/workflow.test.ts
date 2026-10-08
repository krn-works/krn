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
