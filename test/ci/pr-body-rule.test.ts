import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bodyProblems } from '../../src/ci/pr-body-rule.ts';
import { goalPrBody } from '../../src/cli/lane-run/delivery.ts';
import { renderPrBody } from '../../src/cli/pr-body.ts';
import type { TaskRecord } from '../../src/task/record.ts';

const script = fileURLToPath(
  new URL('../../scripts/pr-body-check.ts', import.meta.url),
);
const task: TaskRecord = {
  id: 't-abc1234' as TaskRecord['id'],
  status: 'open',
  resolution: null,
  created: '2026-11-19',
  priority: 3,
  title: 'Check bodies',
  after: [],
  body: ['Outcome: bodies are checked.\nWhy: empty bodies merged.'],
};
// The body as `krn pr body` writes it, not a hand-written copy (KRN-12).
const written = (refs: boolean) =>
  renderPrBody({
    task,
    commits: ['feat(ci): check bodies (t-abc1234)'],
    verified: 'npm run fast: PASS',
    agent: 'A',
    refs,
  });
const attributionOnly =
  '\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n';

function ciStep(body: string) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, PR_BODY: body },
  });
}

test('a body written by krn pr body is accepted, with Ticket or Refs', () => {
  assert.deepEqual(bodyProblems(written(false)), []);
  assert.deepEqual(bodyProblems(written(true)), []);
});

test('the plainest body with both sections and a Refs line is accepted', () => {
  assert.deepEqual(
    bodyProblems('## Why\n\nx\n\n## Verified\n\ny\n\nRefs: t-abc1234'),
    [],
  );
});

test('a body holding only the attribution line names every missing part', () => {
  const problems = bodyProblems(attributionOnly);
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /"## Why"/u);
  assert.match(problems.join('\n'), /"## Verified"/u);
  assert.match(problems.join('\n'), /Ticket.*Refs/u);
});

test('an empty section or a heading in running text does not count', () => {
  const problems = bodyProblems(
    '## Why\n\n## Verified\n\nsee ## Why above\n\nTicket: t-abc1234 done',
  );
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems.join('\n'), /"## Why" section is empty/u);
  assert.match(problems.join('\n'), /Ticket.*Refs/u);
});

test('a repository without a task tracker needs no Ticket or Refs line', () => {
  assert.deepEqual(
    bodyProblems('## Why\n\nx\n\n## Verified\n\ny\n', { tracked: false }),
    [],
  );
});

test('the CI step refuses a bad PR_BODY with exit 65 and accepts a written one', () => {
  const bad = ciStep(attributionOnly);
  assert.equal(bad.status, 65);
  assert.match(bad.stderr, /pr-body: FAIL .*"## Why"/u);
  const unset = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== 'PR_BODY'),
    ),
  });
  assert.equal(unset.status, 65);
  const good = ciStep(written(false));
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /pr-body: PASS/u);
});

test('CI runs the PR body step on pull requests with PR_BODY', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    workflow,
    /- name: Pull request body\n\s+if: \$\{\{ github\.event_name == 'pull_request' \}\}\n\s+env:\n\s+PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}\n\s+run: node scripts\/pr-body-check\.ts/u,
  );
  assert.match(workflow, /types: \[opened, synchronize, reopened, edited\]/u);
});

test('krn pr body run without --verified leaves a TODO placeholder that the rule refuses', () => {
  const placeholder = renderPrBody({
    task,
    commits: ['feat(ci): check bodies (t-abc1234)'],
    verified: '',
    agent: 'A',
    refs: true,
  });
  assert.deepEqual(bodyProblems(placeholder), [
    '"## Verified" section is still the TODO placeholder',
  ]);
});

test('a goal lane-run body carries Why and Verified, so ship accepts it where no tracker runs', () => {
  const body = goalPrBody('Pages load faster.', ['perf(web): cache pages'], 'npm test: pass');
  assert.deepEqual(bodyProblems(body, { tracked: false }), []);
});
