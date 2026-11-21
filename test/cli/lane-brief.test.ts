// fast-covers: src/repo/contract.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { clauseSection } from '../../src/brain/acceptance-clauses.ts';
import { gatesBlock } from '../../src/brain/worker-packet.ts';
import { laneBriefText, workerRules } from '../../src/cli/lane-brief.ts';

const BASE_DATE = '2026-11-08';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function lane(cwd: string, args: string[], input?: string) {
  return spawnSync(process.execPath, [cli, 'lane', 'brief', ...args], {
    cwd,
    encoding: 'utf8',
    input,
  });
}

test('a lane brief tells the worker that a red test outranks a closed tracker record', () => {
  const text = laneBriefText(
    repo,
    'Task t-abc1234: x\n',
    BASE_DATE,
    't-abc1234',
  );
  assert.match(text, /red test outranks tracker state/u);
  assert.match(text, /Otherwise stay inside Scope/u);
});

test('krn lane brief prints the carrier prefix over a brief file and stdin', () => {
  const brief = 'Task t-abc1234: Add a signup form.\n';
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
    // The universal enforced gates apply to any repository, so the brief names them before the rules.
    const gates = gatesBlock(dir, new Date().toISOString().slice(0, 10));
    assert.ok(gates !== undefined);
    assert.equal(
      result.stdout,
      `Fix the parser.\n\n${gates}\n\n${clauseSection('Fix the parser.')}\n\n${workerRules(dir)}\n`,
    );
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
  const empty = lane(repo, [], '');
  assert.match(
    empty.stderr,
    /pass --file PATH or pipe the brief text on stdin/u,
  );
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
    assert.match(result.stdout, /say in your final reply what blocks you/u);
    assert.doesNotMatch(
      result.stdout,
      /npm|worker-stop|tasks\/<|origin\/main/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the KRN repository brief names its fast check and leaves the rest to the CI Check', () => {
  assert.match(
    workerRules(repo),
    /run 'npm run fast' once[^\n]*the CI Check on the PR runs the rest/u,
  );
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
    /plainest hand-written example of that format, never only input your own code produced/u,
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
    /every claim about an external system[^\n]*command you ran and its exit code/u,
  );
});

function armsOnRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lane-arms-on-'));
  writeFileSync(join(dir, 'krn.json'), '{"test":"make check"}');
  return dir;
}

test('the acceptance-clause section is in the brief by default and KRN_ACCEPTANCE_CLAUSES=0 drops it', () => {
  const body = '1. Parse the header line\n2. Reject an empty header';
  const before = process.env.KRN_ACCEPTANCE_CLAUSES;
  try {
    delete process.env.KRN_ACCEPTANCE_CLAUSES;
    assert.match(
      laneBriefText(armsOnRepo(), body, BASE_DATE),
      /Acceptance clauses \(cover every one\):\n1\. Parse the header line\n2\. Reject an empty header/u,
    );
    const oneLine = laneBriefText(armsOnRepo(), 'Add a signup form', BASE_DATE);
    assert.match(oneLine, /Acceptance clauses \(write them first\)/u);
    assert.match(oneLine, /non-ASCII/u);
    assert.match(oneLine, /duplicate submit/u);
    process.env.KRN_ACCEPTANCE_CLAUSES = '0';
    assert.doesNotMatch(
      laneBriefText(armsOnRepo(), body, BASE_DATE),
      /Acceptance clauses/u,
    );
  } finally {
    if (before === undefined) delete process.env.KRN_ACCEPTANCE_CLAUSES;
    else process.env.KRN_ACCEPTANCE_CLAUSES = before;
  }
});

test('a lane brief asks the worker to list unstated names and behaviors and pass them to krn pr body', () => {
  const text = laneBriefText(
    repo,
    'Task t-abc1234: x\n',
    BASE_DATE,
    't-abc1234',
  );
  assert.match(text, /choices the task left open/u);
  assert.match(text, /--assumptions <text>/u);
});

test('the lane brief of a goal without a Scope line prints a precedent section naming the sibling test', (t) => {
  const php = mkdtempSync(join(tmpdir(), 'krn-lane-php-'));
  t.after(() => rmSync(php, { recursive: true, force: true }));
  mkdirSync(join(php, 'src'), { recursive: true });
  mkdirSync(join(php, 'tests'), { recursive: true });
  writeFileSync(join(php, 'src/Invoice.php'), '<?php class Invoice {}\n');
  writeFileSync(
    join(php, 'tests/InvoiceTest.php'),
    '<?php class InvoiceTest {}\n',
  );
  const git = (...args: string[]) =>
    spawnSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: php },
    );
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: invoice');
  const text = laneBriefText(php, 'Goal: Invoice totals round up.', BASE_DATE);
  assert.match(text, /Precedent \(no Scope: line/u);
  assert.match(text, /`tests\/InvoiceTest\.php`/u);
});

test('the clause section reads the task words only, never the delivery boilerplate around them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-arms-on-'));
  try {
    writeFileSync(join(dir, 'krn.json'), '{"test":"make check"}');
    const text = laneBriefText(
      dir,
      'Task t-abc1234: x\n\nOutcome: o\n\nDeliver this task in the current worktree: commit it. Run the check; ship it.',
      BASE_DATE,
      't-abc1234',
    );
    assert.match(text, /Acceptance clauses \(write them first\)/u);
    assert.doesNotMatch(text, /Acceptance clauses \(cover every one\)/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a contract with arms off drops the test-first rule and the clause section from the brief', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-arms-'));
  try {
    const body = 'Task t-abc1234: x\n1. First thing.\n2. Second thing.\n';
    const brief = (contract: string) => {
      writeFileSync(join(dir, 'krn.json'), contract);
      return laneBriefText(dir, body, BASE_DATE, 't-abc1234');
    };
    const on = brief('{"test":"make check"}');
    assert.match(on, /Test first: prove red at base/u);
    assert.match(on, /Acceptance clauses \(cover every one\)/u);
    const off = brief(
      '{"test":"make check","arms":{"red-first":false,"clauses":false}}',
    );
    assert.doesNotMatch(off, /Test first: prove red at base/u);
    assert.doesNotMatch(off, /Acceptance clauses/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
