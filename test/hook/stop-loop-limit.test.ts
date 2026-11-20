import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stopHook } from '../../src/hook/stop.ts';

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stop-loop-'));
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return dir;
}

const input = (session: string) => JSON.stringify({ session_id: session });
const refuse = () => 'Stop refused: nothing committed';

test('three identical refusals with no edit allow the fourth stop and record a stop-loop verdict', () => {
  const dir = checkout();
  const env = { CLAUDE_PROJECT_DIR: dir };
  const codes = [1, 2, 3, 4].map(
    () => stopHook(input('s1'), env, '', refuse).code,
  );
  assert.deepEqual(codes, [2, 2, 2, 0]);
  const record = JSON.parse(
    readFileSync(join(dir, '.krn/runs/stop-loop/s1.json'), 'utf8'),
  );
  assert.equal(record.verdict, 'stop-loop');
});

test('an edit between refusals restarts the count', () => {
  const dir = checkout();
  const env = { CLAUDE_PROJECT_DIR: dir };
  const codes = [1, 2, 3, 4, 5].map((n) => {
    writeFileSync(join(dir, 'a.txt'), `edit ${n}\n`);
    return stopHook(input('s2'), env, '', refuse).code;
  });
  assert.deepEqual(codes, [2, 2, 2, 2, 2]);
});

test('a different refusal restarts the count and sessions count apart', () => {
  const dir = checkout();
  const env = { CLAUDE_PROJECT_DIR: dir };
  stopHook(input('s3'), env, '', refuse);
  stopHook(input('s3'), env, '', refuse);
  assert.equal(
    stopHook(input('s3'), env, '', () => 'Stop refused: other').code,
    2,
  );
  assert.equal(stopHook(input('s4'), env, '', refuse).code, 2);
});

test('a refusal is saved under .krn/runs/stop-check so the lane and the lead can read why', () => {
  const dir = checkout();
  const env = { CLAUDE_PROJECT_DIR: dir };
  const out = stopHook(input('s5'), env, '', refuse);
  assert.equal(out.code, 2);
  const saved = join(dir, '.krn/runs/stop-check/last-refusal.txt');
  assert.equal(existsSync(saved), true);
  assert.equal(
    readFileSync(saved, 'utf8'),
    'Stop refused: nothing committed\n',
  );
});

/** Four Stops in a row on a branch whose test command fails with `command`; the exit codes of each Stop. */
function failingStops(t: TestContext, command: string): number[] {
  const dir = mkdtempSync(join(tmpdir(), 'stop-loop-fail-'));
  const state = mkdtempSync(join(tmpdir(), 'stop-loop-state-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });
  const git = (...args: string[]) =>
    assert.equal(spawnSync('git', ['-C', dir, ...args]).status, 0);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  writeFileSync(
    join(dir, 'krn.json'),
    `${JSON.stringify({ base: 'main', test: command })}\n`,
  );
  writeFileSync(join(dir, 'a.py'), 'x = 1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(dir, 'a.py'), 'x = 2\n');
  git('add', '.');
  git('commit', '-q', '-m', 'change');
  mkdirSync(join(dir, '.krn/runs/stop-check'), { recursive: true });
  writeFileSync(join(dir, '.krn/runs/stop-check/diagnostics'), '');
  const env = {
    ...process.env,
    XDG_STATE_HOME: state,
    CLAUDE_PROJECT_DIR: dir,
    KRN_SESSION_CLASS: 'lane',
    KRN_LANE: 'work',
    KRN_TEST_FIRST: '0',
    KRN_ACCEPTANCE_CLAUSES: '0',
    KRN_BASE_GREEN: '1',
    KRN_TEST_SLOT_HELD: '1',
  };
  const payload = JSON.stringify({ session_id: 's1', cwd: dir });
  const codes: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    codes.push(stopHook(payload, env, 'work').code);
  }
  return codes;
}

test('a failing test command refused identically is stuck although each refusal names a new log file', (t) => {
  assert.deepEqual(
    failingStops(t, 'echo FAIL test_a.py; exit 1'),
    [2, 2, 2, 0],
  );
});

test('test output that differs between runs keeps the stop blocked, even when it looks like a log note', (t) => {
  assert.deepEqual(
    failingStops(
      t,
      'echo FAIL test_a.py; n=$(wc -l < .krn/runs/stop-check/diagnostics); echo "Unexpected text (full log: diagnostic-$n)"; echo attempt >> .krn/runs/stop-check/diagnostics; exit 1',
    ),
    [2, 2, 2, 2],
  );
});
