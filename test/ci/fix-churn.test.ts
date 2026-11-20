import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  checkFixChurn,
  churn,
  FILE_LIMIT,
  TASK_LIMIT,
} from '../../scripts/fix-churn.ts';

const script = join(import.meta.dirname, '../../scripts/fix-churn.ts');

const fixes = (file: string, count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => ({
    subject: `fix(ship): edge case ${from + i} (t-aaaa${String(from + i).padStart(3, '0')})`,
    files: [file, `test/ci/case-${from + i}.test.ts`],
  }));
const named =
  'Root cause: ship reads raw gh output with no state model\nRedesign: t-redesgn';

test('a fix touching a file fixed for FILE_LIMIT tasks needs a root cause and a redesign', () => {
  const commits = fixes('src/ci/ship.ts', FILE_LIMIT);
  const bare = checkFixChurn({
    title: 'fix(ship): another edge case (t-bbbbbbb)',
    changed: ['src/ci/ship.ts'],
    commits,
  });
  assert.equal(bare.ok, false);
  assert.match(bare.findings[0] ?? '', /src\/ci\/ship\.ts: fixed for 6 tasks/u);
  assert.match(bare.findings[0] ?? '', /edge case 0/u);
  assert.equal(bare.problems.length, 2);
  const lines = checkFixChurn({
    title: 'fix(ship): another edge case (t-bbbbbbb)',
    body: named,
    changed: ['src/ci/ship.ts'],
    commits,
  });
  assert.deepEqual([lines.ok, lines.overridden], [true, true]);
});

test('one fewer task, a feat, a test-only touch and a docs touch pass without lines', () => {
  const commits = fixes('src/ci/ship.ts', FILE_LIMIT - 1);
  for (const [title, changed] of [
    ['fix(ship): edge (t-bbbbbbb)', ['src/ci/ship.ts']],
    ['feat(ship): new (t-bbbbbbb)', ['src/ci/ship.ts']],
  ] as const)
    assert.equal(
      checkFixChurn({ title, changed: [...changed], commits }).ok,
      true,
    );
  const hot = fixes('src/ci/ship.ts', FILE_LIMIT + 2);
  for (const changed of [['test/ci/ship.test.ts'], ['docs/x.md']])
    assert.equal(
      checkFixChurn({
        title: 'fix(ship): x (t-bbbbbbb)',
        changed,
        commits: hot,
      }).ok,
      true,
    );
});

test('several commits of one task count as one fix of the file', () => {
  const commits = Array.from({ length: FILE_LIMIT + 3 }, (_, i) => ({
    subject: `fix(ship): step ${i} (t-sametsk)`,
    files: ['src/ci/ship.ts'],
  }));
  assert.equal(
    checkFixChurn({
      title: 'fix(ship): x (t-bbbbbbb)',
      changed: ['src/ci/ship.ts'],
      commits,
    }).ok,
    true,
  );
});

test('a task with TASK_LIMIT fixes after its feature is a fix chain; fixes before it are not', () => {
  // git log order: newest first.
  const after = [
    ...Array.from({ length: TASK_LIMIT }, (_, i) => ({
      subject: `fix(eval): follow-up ${i} (t-chained) (#${10 + i})`,
      files: [`src/evals/x${i}.ts`],
    })),
    { subject: 'feat(eval): screening (t-chained) (#9)', files: [] },
  ];
  const chained = checkFixChurn({
    title: 'fix(eval): yet another (t-chained)',
    changed: ['src/evals/y.ts'],
    commits: after,
  });
  assert.equal(chained.ok, false);
  assert.match(chained.findings[0] ?? '', /t-chained: 2 fix commits after/u);
  const before = [after[2] as (typeof after)[number], ...after.slice(0, 2)];
  assert.equal(churn(before).tasks.size, 0);
});

test('a Redesign line must name this PR or a task record that exists', () => {
  const commits = fixes('src/ci/ship.ts', FILE_LIMIT);
  const input = {
    title: 'fix(ship): x (t-bbbbbbb)',
    changed: ['src/ci/ship.ts'],
    commits,
    taskExists: (id: string) => id === 't-realtsk',
  };
  const missing = checkFixChurn({
    ...input,
    body: 'Root cause: no state model for gh replies\nRedesign: t-nosuchx',
  });
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join('\n'), /t-nosuchx, which has no tasks/u);
  // The Redesign match ignores case, so "This PR" once fell through to the task lookup and failed.
  for (const redesign of ['t-realtsk', 'this PR', 'This PR'])
    assert.equal(
      checkFixChurn({
        ...input,
        body: `Root cause: no state model for gh replies\nRedesign: ${redesign}`,
      }).ok,
      true,
      redesign,
    );
  assert.equal(
    checkFixChurn({ ...input, body: 'Root cause: tbd\nRedesign: this PR' }).ok,
    false,
    'a root cause of a few characters names no class',
  );
});

test('the script refuses a hot fix over real git history and passes once the lines are added', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-churn-'));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
    git('init', '-q', '-b', 'main');
    const commit = (path: string, text: string, subject: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
      git('add', '-A');
      git('commit', '-q', '-m', subject);
    };
    commit('src/ci/ship.ts', '0\n', 'feat(ship): ship (t-shipfea)');
    for (let i = 0; i < FILE_LIMIT; i += 1)
      commit(
        'src/ci/ship.ts',
        `${i + 1}\n`,
        `fix(ship): case ${i} (t-case00${i})`,
      );
    const base = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', '-b', 'lane');
    commit('src/ci/ship.ts', 'next\n', 'fix(ship): next case (t-nextcas)');
    commit(
      'tasks/t-redesgn.json',
      '{}\n',
      'chore(tasks): redesign (t-redesgn)',
    );
    const run = (body: string) =>
      spawnSync(process.execPath, [script, base, 'HEAD'], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PR_TITLE: 'fix(ship): next case (t-nextcas)',
          PR_BODY: body,
        },
      });
    const refused = run('');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(
      refused.stdout,
      /fix-churn: src\/ci\/ship\.ts: fixed for 6 tasks/u,
    );
    assert.match(refused.stdout, /fix\(ship\): case 0 \(t-case000\)/u);
    assert.match(refused.stderr, /Root cause:/u);
    const named = run(
      'Root cause: ship reads raw gh output with no state model\nRedesign: t-redesgn',
    );
    assert.equal(named.status, 0, named.stdout + named.stderr);
    assert.match(named.stdout, /root cause and redesign named/u);
    const report = spawnSync(process.execPath, [script, '--report', base], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /hot file 6 src\/ci\/ship\.ts/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
