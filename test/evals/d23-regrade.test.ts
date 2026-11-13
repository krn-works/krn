import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { failingFiles, outOfScope } from '../../evals/d23/grade.ts';
import {
  classifyUnit,
  mcnemarP,
  regradeUnit,
  summaryLine,
  type UnitGrade,
} from '../../evals/d23/regrade.ts';
import { parseLog, select } from '../../evals/d23/select.ts';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test('a fixture unit is graded by the hidden test: the fixing patch passes, the wrong one fails, scope is separate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd23-regrade-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'test'), { recursive: true });
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@invalid');
    writeFileSync(join(repo, 'value.js'), 'export const value = 1;\n');
    writeFileSync(join(repo, 'notes.md'), 'kept\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'parent');
    writeFileSync(join(repo, 'value.js'), 'export const value = 2;\n');
    writeFileSync(
      join(repo, 'test/value.test.js'),
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { value } from '../value.js';\ntest('value is two', () => assert.equal(value, 2));\n",
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'fix(value): the value is two (#9)');
    const results = join(root, 'results');
    mkdirSync(results);
    const fix =
      '--- a/value.js\n+++ b/value.js\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n';
    writeFileSync(join(results, '9.K.patch'), fix);
    writeFileSync(join(results, '9.K.files'), 'value.js\nAGENTS.md\n');
    // The plain arm recreates notes.md, which already exists on the parent; only that path is skipped.
    writeFileSync(
      join(results, '9.P.patch'),
      `${fix}--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+mine\n`,
    );
    writeFileSync(join(results, '9.P.files'), '');
    const cls = await classifyUnit('9', {
      repo,
      ref: 'main',
      results,
      work: join(root, 'work-classify'),
      fullSuite: false,
    });
    assert.deepEqual(cls.failToPass, ['test/value.test.js']);
    assert.equal(cls.validOnMerge, true);
    const grade = await regradeUnit('9', {
      repo,
      ref: 'main',
      results,
      work: join(root, 'work'),
      fullSuite: false,
    });
    assert.deepEqual(grade.failToPass, ['test/value.test.js']);
    assert.equal(grade.validOnMerge, true);
    assert.equal(grade.K.functional, true);
    assert.equal(grade.K.scopeClean, false);
    assert.deepEqual(grade.K.outOfScope, ['AGENTS.md']);
    assert.equal(grade.P.functional, true);
    assert.deepEqual(grade.P.excluded, ['notes.md']);
    assert.equal(grade.P.scopeClean, true);
    assert.equal(
      summaryLine([grade]),
      'K functional 1/1, P functional 1/1, K scope-clean 0/1, P scope-clean 1/1; paired K 1/1, P 1/1; McNemar p=1.000',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scope and failing-file parsing follow the protocol rules', () => {
  assert.deepEqual(
    outOfScope([
      'src/a.ts',
      '.agents/skills/x.md',
      'tasks/t-1.json',
      'test/a.test.ts',
    ]),
    ['.agents/skills/x.md', 'tasks/t-1.json'],
  );
  const log =
    "not ok 1 - x\n  ---\n  location: '/w/c/test/a.test.ts:9:1'\nok 2 - y\n";
  assert.deepEqual(failingFiles(log, '/w/c'), ['test/a.test.ts']);
});

test('a unit where one arm produced no patch counts for neither arm in the paired line', () => {
  const arm = (ran: boolean, functional: boolean) =>
    ({ ran, functional, scopeClean: true }) as UnitGrade['K'];
  const unit = (k: UnitGrade['K'], p: UnitGrade['P']) =>
    ({ validOnMerge: true, K: k, P: p }) as UnitGrade;
  assert.equal(
    summaryLine([
      unit(arm(true, true), arm(false, false)),
      unit(arm(true, false), arm(true, true)),
    ]),
    'K functional 1/2, P functional 1/2, K scope-clean 2/2, P scope-clean 2/2; paired K 0/1, P 1/1; McNemar p=1.000',
  );
});

test('the McNemar p-value is the exact two-sided binomial over discordant pairs', () => {
  assert.equal(mcnemarP(5, 0), '0.062');
  assert.equal(mcnemarP(3, 3), '1.000');
  assert.equal(mcnemarP(0, 0), '1.000');
  assert.equal(mcnemarP(1, 7), '0.070');
  assert.equal(mcnemarP(2, 10), '0.039');
});

test('unit selection keeps task-titled PRs that change a test and a source file, newest first, minus the excluded', () => {
  const log = [
    '\u0001feat(a): a (t-aaaaaaa) (#30)\nsrc/a.ts\ntest/a.test.ts\n',
    '\u0001feat(b): no task (#29)\nsrc/b.ts\ntest/b.test.ts\n',
    '\u0001fix(c): only test (t-ccccccc) (#28)\ntest/c.test.ts\ntasks/t-ccccccc.json\n',
    '\u0001fix(d): only source (t-ddddddd) (#27)\nsrc/d.ts\n',
    '\u0001fix(e): e (t-eeeeeee) (#26)\nscripts/e.ts\ntest/e.test.mjs\n',
    '\u0001fix(f): f (t-fffffff) (#25)\nsrc/f.ts\ntest/f.test.ts\n',
  ].join('');
  assert.deepEqual(select(parseLog(log), {}), ['30', '26', '25']);
  assert.deepEqual(
    select(parseLog(log), { limit: 2, exclude: new Set(['30']) }),
    ['26', '25'],
  );
});

test('unit selection drops a follow-up PR whose task an earlier first-parent commit already named', () => {
  // D23 units 586 and 467: the parent already delivered the task the replay prompts with.
  const log = [
    '\u0001fix(ship): follow-up (t-2yggc19) (#586)\nsrc/ship.ts\ntest/ship.test.ts\n',
    '\u0001feat(plan): first (t-2yggc19) (#585)\nsrc/plan.ts\ntest/plan.test.ts\n',
    '\u0001Keep roadmap clean (t-kfydr8a) (#467)\ndocs/x.md\nscripts/y.mjs\ntest/r.test.ts\n',
    '\u0001Record trims without a PR suffix (t-kfydr8a)\ndocs/z.md\n',
  ].join('');
  assert.deepEqual(select(parseLog(log), {}), ['585']);
});
