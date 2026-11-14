// fast-covers: src/repo/contract.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { laneBrief } from '../../evals/fr40/lanes.ts';
import { BASE_DATE, generate } from '../../evals/fr40/tasks.ts';
import { laneBriefText, workerRules } from '../../src/cli/lane-brief.ts';

// KRN-12: the receiver is the FR-40 lane runner; its arm-B prompt is the measured carrier.
const repo = fileURLToPath(new URL('../..', import.meta.url));
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function lane(cwd: string, args: string[], input?: string) {
  return spawnSync(process.execPath, [cli, 'lane', 'brief', ...args], {
    cwd,
    encoding: 'utf8',
    input,
  });
}

test('the lane brief of every frozen unit equals the lane runner arm-B prompt', (t) => {
  // The live record file rewords frozen records on purpose; the frozen carrier is checked without it.
  const frozen = mkdtempSync(join(tmpdir(), 'krn-lane-frozen-'));
  t.after(() => rmSync(frozen, { recursive: true, force: true }));
  mkdirSync(join(frozen, '.krn'), { recursive: true });
  copyFileSync(
    join(repo, 'evals/fr40/records.json'),
    join(frozen, '.krn/conventions.json'),
  );
  const units = generate();
  assert.ok(units.length > 0);
  for (const unit of units) {
    const brief = `${unit.prompt.trim()}\n`;
    assert.equal(
      laneBriefText(frozen, brief, BASE_DATE, unit.id),
      `${laneBrief(unit, 'B').prompt.trimEnd()}\n\n${workerRules(frozen)}\n`,
      unit.id,
    );
  }
});

test('a lane brief tells the worker that a red test outranks a closed tracker record', () => {
  const text = laneBriefText(
    repo,
    'Task t-abc1234: x\n',
    BASE_DATE,
    't-abc1234',
  );
  assert.match(
    text,
    /closed task record, an earlier commit or a green existing suite never means done/u,
  );
  assert.match(text, /red test outranks tracker state/u);
  assert.match(text, /Otherwise stay inside Scope/u);
  assert.match(text, /revert such an edit before you commit/u);
});

test('krn lane brief prints the carrier prefix over a brief file and stdin', () => {
  const unit = generate()[0];
  assert.ok(unit !== undefined);
  const brief = `${unit.prompt.trim()}\n`;
  const dir = mkdtempSync(join(tmpdir(), 'krn-lane-brief-'));
  try {
    const file = join(dir, 'brief.md');
    writeFileSync(file, brief);
    const expected = laneBriefText(repo, brief, BASE_DATE, 'lane-brief');
    assert.match(expected, /^Repository conventions \(brain packet /u);
    const fromFile = lane(repo, ['--file', file, '--as-of', BASE_DATE]);
    assert.equal(fromFile.status, 0, fromFile.stderr);
    assert.equal(fromFile.stdout, expected);
    const fromStdin = lane(repo, ['--as-of', BASE_DATE], brief);
    assert.equal(fromStdin.status, 0, fromStdin.stderr);
    assert.equal(fromStdin.stdout, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository without records gets the brief and the worker rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krn-lane-brief-'));
  try {
    spawnSync('git', ['init', '-q', dir]);
    const result = lane(dir, [], 'Fix the parser.\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `Fix the parser.\n\n${workerRules(dir)}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('krn lane brief refuses an empty brief, a bad date and a bad task id', () => {
  for (const [args, input] of [
    [[], '  \n'],
    [['--as-of', '10-11-2026'], 'x\n'],
    [['--task', 'nope'], 'x\n'],
  ] as const) {
    const result = lane(repo, [...args], input);
    assert.equal(result.status, 64, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '');
  }
});

test('a pytest repository on master without a tracker gets its own commands, never npm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krn-lane-brief-py-'));
  try {
    const git = (...args: string[]) =>
      spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'master');
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "p"\n');
    git('add', '.');
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '-qm',
      'seed',
    );
    const result = lane(dir, [], 'Fix the parser.\n');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /'\.venv\/bin\/python -m pytest'/u);
    assert.match(result.stdout, /branch 'master'/u);
    assert.match(result.stdout, /BLOCKER:/u);
    assert.doesNotMatch(
      result.stdout,
      /npm|worker-stop|tasks\/<|origin\/main/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the KRN repository brief keeps the Stop script check', () => {
  assert.match(workerRules(repo), /bin\/krn hook stop --check/u);
});

test('a lane brief tells the worker to test the plainest hand-written input of every named format', () => {
  // A reader tested only with its own tool's output misses the plain form the task wording allows.
  const text = laneBriefText(
    repo,
    'Task t-abc1234: x\n',
    BASE_DATE,
    't-abc1234',
  );
  assert.match(
    text,
    /plainest hand-written example of that format exactly as the task words it, never only input your own code or tool produced/u,
  );
  assert.match(
    workerRules(repo),
    /must accept every form the wording allows, including the shortest and plainest one/u,
  );
});

test('the shared worker rules carry no wording taken from an eval unit or this repository', () => {
  const rules = workerRules(repo);
  assert.doesNotMatch(rules, /diff --git|---\/\+\+\+|unit[- ]?\d+|D23/u);
  assert.doesNotMatch(rules, /tasks\/ and the roadmap/u);
});

test('a lane brief requires the command and exit code behind every external-system claim', () => {
  const text = laneBriefText(
    repo,
    'Task t-abc1234: x\n',
    BASE_DATE,
    't-abc1234',
  );
  assert.match(
    text,
    /every claim about an external system[^\n]*exact command you ran and its exit code/u,
  );
});
