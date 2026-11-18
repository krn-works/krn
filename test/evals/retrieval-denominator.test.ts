import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const run = new URL('../../evals/retrieval/run.ts', import.meta.url).pathname;
const casesPath = new URL('../../evals/retrieval/cases.json', import.meta.url)
  .pathname;

type Item = { audience: string; files: string[]; violated: string[] };

test('the retrieval report prints reachable and total denominators per moment', () => {
  const result = spawnSync('node', [run], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const cases = (
    JSON.parse(readFileSync(casesPath, 'utf8')) as { cases: Item[] }
  ).cases;
  const lines = result.stdout
    .trim()
    .split('\n')
    .filter((row) => row.startsWith('recall@5 '));
  assert.equal(lines.length, 3);
  for (const moment of ['task-start', 'query', 'edit']) {
    const text = lines.find((row) => row.startsWith(`recall@5 ${moment} `));
    assert.ok(text, `a line for ${moment}`);
    const match =
      /\((\d+)\/(\d+) reachable violated records.*of all (\d+) violated records [\d.]+ \((\d+)\/(\d+), (\d+) cases\)/u.exec(
        text,
      );
    assert.ok(match, text);
    const [hits, reachable, labels, hitsAgain, labelsAgain] = match
      .slice(1, 6)
      .map(Number) as [number, number, number, number, number];
    const applicable = cases.filter(
      (item) => item.audience !== 'lead' || moment === 'task-start',
    );
    const expected = applicable.reduce(
      (sum, item) => sum + item.violated.length,
      0,
    );
    assert.equal(labels, expected, 'total denominator counts every label');
    assert.equal(labelsAgain, labels);
    assert.equal(hitsAgain, hits);
    assert.equal(Number(match[6]), applicable.length);
    assert.ok(reachable <= labels);
    assert.ok(hits <= reachable);
  }
  const edit = lines.find((row) => row.startsWith('recall@5 edit '));
  const m = /\(\d+\/(\d+) reachable.*of all (\d+) violated/u.exec(edit ?? '');
  assert.ok(
    Number(m?.[1]) < Number(m?.[2]),
    'edit drops labels no channel reaches',
  );
});

test('the edit moment recalls at least 0.75 of reachable labels and names why each unreachable label is unreachable', () => {
  const metric = spawnSync('node', [run, '--metric', 'recall-at-5-edit'], {
    encoding: 'utf8',
  });
  assert.equal(metric.status, 0, metric.stderr);
  assert.ok(Number(metric.stdout) >= 0.75, `edit recall ${metric.stdout}`);
  const report = spawnSync('node', [run], { encoding: 'utf8' });
  const reasons = report.stdout
    .split('\n')
    .filter((row) => row.startsWith('unreachable edit '));
  const edit = /\((\d+)\/(\d+) reachable.*of all (\d+)/u.exec(
    report.stdout.split('\n').find((row) => row.startsWith('recall@5 edit ')) ??
      '',
  );
  assert.ok(edit, 'the edit line');
  assert.ok(reasons.length > 0, 'unreachable labels are explained');
  for (const row of reasons) assert.match(row, /: \S/u);
});
