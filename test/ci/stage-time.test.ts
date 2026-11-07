import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyze,
  percentile,
  renderReport,
} from '../../scripts/ci-stage-time.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const capturePath = fileURLToPath(
  new URL('../fixtures/ci-stage-capture.json', import.meta.url),
);

test('percentile picks the nearest rank', () => {
  assert.equal(percentile([], 0.5), undefined);
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
});

test('analysis of a verbatim capture counts pushes, reruns and stages', () => {
  const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
  const { stages, counts } = analyze(capture);
  assert.equal(counts.prs, 3);
  assert.ok(counts.reruns >= 1, 'PR #278 was rerun once');
  assert.ok(stages.get('job run: Test (shard)')?.length === 24);
  assert.ok(stages.has('Check done -> merge'));
});

test('the report command prints the per-stage table', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/ci-stage-time.mjs', 'report', capturePath],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| stage \| n \| median s \| p90 s \|/u);
  assert.match(result.stdout, /\| job run: Test \(shard\) \| 24 \|/u);
  assert.equal(
    result.stdout,
    renderReport(analyze(JSON.parse(readFileSync(capturePath, 'utf8')))),
  );
});

test('an unknown mode fails with exit 64', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/ci-stage-time.mjs', 'nope'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 64);
});
