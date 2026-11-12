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
import { laneBriefText, WORKER_RULES } from '../../src/cli/lane.ts';

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
  mkdirSync(join(frozen, 'evals/fr40'), { recursive: true });
  copyFileSync(
    join(repo, 'evals/fr40/records.json'),
    join(frozen, 'evals/fr40/records.json'),
  );
  const units = generate();
  assert.ok(units.length > 0);
  for (const unit of units) {
    const brief = `${unit.prompt.trim()}\n`;
    assert.equal(
      laneBriefText(frozen, brief, BASE_DATE, unit.id),
      `${laneBrief(unit, 'B').prompt.trimEnd()}\n\n${WORKER_RULES}\n`,
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
    assert.equal(result.stdout, `Fix the parser.\n\n${WORKER_RULES}\n`);
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
