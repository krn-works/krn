import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  appendExposure,
  EXPOSURES_FILE,
  effectRows,
  exposureOf,
  readExposures,
} from '../../src/brain/exposures.ts';

const input = {
  run: 'lane-a',
  task: 't-1',
  channel: 'lane',
  served: ['r-a', 'r-b'],
  withheld: ['r-c'],
  rework: 0,
};

test('an exposure is appended as one JSON line with the stated fields and read back', () => {
  const main = mkdtempSync(join(tmpdir(), 'krn-exposures-'));
  try {
    appendExposure(main, exposureOf({ ...input, laneOk: true }));
    appendExposure(
      main,
      exposureOf({ ...input, run: 'lane-b', laneOk: false }),
    );
    const lines = readFileSync(join(main, EXPOSURES_FILE), 'utf8')
      .trim()
      .split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0] ?? ''), {
      run: 'lane-a',
      task: 't-1',
      channel: 'lane',
      served: ['r-a', 'r-b'],
      withheld: ['r-c'],
      outcome: { 'r-a': 'followed', 'r-b': 'followed' },
      lane_ok: true,
      rework: 0,
    });
    assert.deepEqual(readExposures(main)[1]?.outcome, {
      'r-a': 'violated',
      'r-b': 'violated',
    });
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('a run that served and withheld nothing leaves no line, and rework counts as violated', () => {
  const main = mkdtempSync(join(tmpdir(), 'krn-exposures-'));
  try {
    appendExposure(
      main,
      exposureOf({ ...input, served: [], withheld: [], laneOk: true }),
    );
    assert.deepEqual(readExposures(main), []);
    assert.equal(
      exposureOf({ ...input, rework: 1, laneOk: true }).outcome['r-a'],
      'violated',
    );
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('effect prints one row per record with served-versus-withheld numbers', () => {
  const rows = effectRows([
    exposureOf({ ...input, laneOk: true }),
    exposureOf({ ...input, run: 'lane-b', laneOk: false }),
    exposureOf({
      ...input,
      run: 'lane-c',
      served: ['r-c'],
      withheld: ['r-a'],
      laneOk: true,
    }),
  ]);
  assert.deepEqual(rows, [
    'r-a: served 2 (ok 50%, followed 1, violated 1) withheld 1 (ok 100%)',
    'r-b: served 2 (ok 50%, followed 1, violated 1) withheld 0 (ok -)',
    'r-c: served 1 (ok 100%, followed 1, violated 0) withheld 2 (ok 50%)',
  ]);
});
