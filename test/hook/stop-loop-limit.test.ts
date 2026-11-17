import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
