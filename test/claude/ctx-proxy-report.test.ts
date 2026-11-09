import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseMetrics, report } from '../../scripts/claude/ctx-proxy-report.ts';

const fixture = fileURLToPath(
  new URL('./evidence/ctx-proxy-report-metrics.jsonl', import.meta.url),
);
const script = fileURLToPath(
  new URL('../../scripts/claude/ctx-proxy-report.ts', import.meta.url),
);

test('the report sums per session and prices cold-only clearing', () => {
  const lines = report(parseMetrics(readFileSync(fixture, 'utf8')));
  assert.equal(lines[1], 'aaa 3 3306 1200 33.3% 700');
  assert.equal(lines[2], 'bbb 1 100 200 100.0% 200');
  assert.equal(
    lines[3],
    'verdict: 2 sessions, 4 requests, 50.0% cold, cold-only clearing would save 900 of 3406 input tokens (26.42%)',
  );
});

test('the command prints the same verdict and handles a missing file', () => {
  const run = (path: string) =>
    spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
  assert.match(run(fixture).stdout, /verdict: 2 sessions, 4 requests/u);
  assert.match(run('/nonexistent/m.jsonl').stdout, /^verdict: no metrics/u);
});
