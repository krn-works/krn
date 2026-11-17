import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  appendExposure,
  exposureOf,
  readExposures,
} from '../../src/brain/exposures.ts';
import { judgeStop } from '../../src/hook/stop.ts';

function sh(cwd: string, ...args: string[]) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
}

function clone(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stop-exposure-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'a@b.c');
  sh(dir, 'config', 'user.name', 'a');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'package.json'), '{}\n');
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', 'work');
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'change');
  return dir;
}

test('a Stop refusal is recorded as a refusal with the claimed task, beside served and withheld ids', () => {
  const dir = clone();
  try {
    appendExposure(
      dir,
      exposureOf({
        run: 'sess-x',
        task: 't-abcdefg',
        channel: 'lane',
        served: ['r-served'],
        withheld: ['r-held'],
        laneOk: true,
      }),
    );
    const env = {
      CLAUDE_PROJECT_DIR: dir,
      KRN_SESSION_CLASS: 'lane',
      KRN_SCOPE: 'src/',
      KRN_TASK: 't-abcdefg',
      KRN_TEST_FIRST: '0',
      KRN_ACCEPTANCE_CLAUSES: '0',
    };
    const refusal = judgeStop(
      { cwd: dir, session_id: 'sess-x', last_assistant_message: 'done' },
      env,
      () => [],
      '',
      undefined,
      (root) => (root === dir ? ['r-refused (floor): exit 1'] : []),
    );
    assert.match(refusal ?? '', /r-refused/u);
    const row = readExposures(dir).find((r) => r.channel === 'stop');
    assert.ok(row, 'the refusal writes a stop row');
    assert.deepEqual(row.refused, ['r-refused']);
    assert.ok(!row.served.includes('r-refused'));
    assert.equal(row.task, 't-abcdefg');
    assert.deepEqual(row.served, ['r-served']);
    assert.deepEqual(row.withheld, ['r-held']);
    assert.equal(row.violated['r-refused'], true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
