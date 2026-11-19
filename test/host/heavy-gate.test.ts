import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultJobWeight, parseRun } from '../../scripts/host/heavy-gate.ts';
import {
  gateLimits,
  hostGateDir,
  hostPressure,
  projectedLoad,
} from '../../src/repo/host-gate.ts';
import { type Admission, withSlot } from '../../src/repo/slot-lock.ts';
import { defaultTestSlots, testSlotOptions } from '../../src/repo/test-slot.ts';

const GATE = join(import.meta.dirname, '../../scripts/host/heavy-gate.ts');

/** A job that records how many jobs run beside it: marker files in `live`, the count appended to `log`. */
const JOB = `
const fs = require('node:fs');
const [live, log] = process.argv.slice(1);
const me = live + '/' + process.pid;
fs.writeFileSync(me, '');
fs.appendFileSync(log, fs.readdirSync(live).length + '\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
fs.appendFileSync(log, fs.readdirSync(live).length + '\\n');
fs.unlinkSync(me);
`;

function runGate(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('exit', (code) => resolve(code));
  });
}

/** Environment of a job outside any held slot, with the host probe turned off so live load cannot decide the test. */
function gateEnv(dir: string, units: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KRN_HEAVY_GATE_DIR: dir,
    KRN_HEAVY_GATE_LOAD_PER_CORE: '100000',
    KRN_HEAVY_GATE_MIN_MB: '0',
    KRN_HEAVY_GATE_UNITS: String(units),
  };
  delete env.KRN_TEST_SLOT_HELD;
  return env;
}

test('three projects with four heavy jobs each never run more than the gate admits and none fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-gate-'));
  try {
    const live = join(root, 'live');
    const log = join(root, 'log');
    mkdirSync(live);
    writeFileSync(log, '');
    const env = gateEnv(join(root, 'gate'), 8);
    const jobs: Promise<number | null>[] = [];
    for (const project of ['alpha', 'beta', 'gamma']) {
      const cwd = join(root, project);
      mkdirSync(cwd);
      for (let job = 0; job < 4; job += 1)
        jobs.push(
          runGate(
            [
              'run',
              '--weight',
              '4',
              '--',
              process.execPath,
              '-e',
              JOB,
              live,
              log,
            ],
            env,
            cwd,
          ),
        );
    }
    const codes = await Promise.all(jobs);
    assert.deepEqual(codes, Array(12).fill(0));
    const counts = readFileSync(log, 'utf8').trim().split('\n').map(Number);
    assert.equal(counts.length, 24);
    assert.ok(Math.max(...counts) <= 2, `peak ${Math.max(...counts)} > 2`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run passes the command exit code through and marks the child as holding a slot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-gate-'));
  try {
    const out = join(root, 'held');
    const code = await runGate(
      [
        'run',
        '--',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.KRN_TEST_SLOT_HELD ?? ''); process.exit(3)`,
      ],
      gateEnv(join(root, 'gate'), 4),
      root,
    );
    assert.equal(code, 3);
    assert.equal(readFileSync(out, 'utf8'), '1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a job already holding a slot runs at once even when the gate is full', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-gate-'));
  try {
    const dir = join(root, 'gate');
    const env = { ...gateEnv(dir, 1), KRN_TEST_SLOT_HELD: '1' };
    const code = await withSlot({ dir, slots: 1 }, () =>
      runGate(['run', '--deadline-ms', '200', '--', 'true'], env, root),
    );
    assert.equal(code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a full gate past the deadline exits 75', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-gate-'));
  try {
    const dir = join(root, 'gate');
    const code = await withSlot({ dir, slots: 1 }, () =>
      runGate(
        ['run', '--deadline-ms', '200', '--', 'true'],
        gateEnv(dir, 1),
        root,
      ),
    );
    assert.equal(code, 75);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a soft run past the deadline runs its command without a slot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-gate-'));
  try {
    const dir = join(root, 'gate');
    const out = join(root, 'held');
    const code = await withSlot({ dir, slots: 1 }, () =>
      runGate(
        [
          'run',
          '--deadline-ms',
          '200',
          '--soft',
          '--',
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.KRN_TEST_SLOT_HELD ?? 'none'); process.exit(4)`,
        ],
        gateEnv(dir, 1),
        root,
      ),
    );
    assert.equal(code, 4);
    assert.equal(readFileSync(out, 'utf8'), 'none');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run without a command, or with a bad weight, is a usage error', async () => {
  assert.throws(() => parseRun([]), /run needs -- <command>/);
  assert.throws(() => parseRun(['--weight', '0', '--', 'x']), /positive/);
  assert.deepEqual(parseRun(['--weight', '2', '--', 'npm', 'test']), {
    command: ['npm', 'test'],
    deadlineMs: undefined,
    soft: false,
    weight: 2,
  });
  assert.throws(() => parseRun(['--soft', '--', 'x']), /--soft needs/);
  const code = await runGate([], gateEnv(tmpdir(), 1), tmpdir());
  assert.equal(code, 64);
});

test('weights add up: a holder waits while its weight does not fit, and a lone holder is admitted whatever its weight', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-gate-'));
  try {
    const order: string[] = [];
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = (): void => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = withSlot({ dir, slots: 4, weight: 3 }, async () => {
      order.push('a');
      started();
      await held;
      order.push('a done');
    });
    await running;
    const waits: string[] = [];
    let waited = (): void => {};
    const waiting = new Promise<void>((resolve) => {
      waited = resolve;
    });
    const second = withSlot(
      {
        dir,
        onWait: (_pid, reason) => {
          waits.push(reason);
          waited();
        },
        pollMs: 5,
        slots: 4,
        weight: 2,
      },
      async () => order.push('b'),
    );
    await waiting;
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['a', 'a done', 'b']);
    assert.deepEqual(waits, ['capacity 3+2 > 4']);
    assert.equal(
      await withSlot({ dir, slots: 2, weight: 9 }, async () => 'alone'),
      'alone',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host pressure is asked only while another job holds a slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-gate-'));
  try {
    let asked = 0;
    const busy = () => {
      asked += 1;
      return 'load 30.0 >= 20.0';
    };
    assert.equal(
      await withSlot({ dir, pressure: busy, slots: 8 }, async () => 'idle'),
      'idle',
    );
    assert.equal(asked, 0);
    await withSlot({ dir, slots: 8 }, async () => {
      await assert.rejects(
        withSlot(
          { deadlineMs: 30, dir, pollMs: 5, pressure: busy, slots: 8 },
          async () => 'never',
        ),
        { name: 'SlotTimeoutError' },
      );
    });
    assert.ok(asked > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host pressure names load past cores x 1.25 and available memory under 2 GB', () => {
  const limits = gateLimits({});
  assert.equal(
    hostPressure({ availableMb: 8000, cores: 16, load1: 19.9 }, limits),
    undefined,
  );
  assert.equal(
    hostPressure({ availableMb: 8000, cores: 16, load1: 20 }, limits),
    'load 20.0 >= 20.0',
  );
  assert.equal(
    hostPressure({ availableMb: 1500, cores: 16, load1: 4 }, limits),
    'available memory 1500 MB < 2048 MB',
  );
});

test('a burst is admitted on projected load: fresh holders count in full until load1 catches up', () => {
  const limits = gateLimits({});
  const idle = { availableMb: 8000, cores: 16, load1: 9 };
  // load1 still shows the host before the burst: 9 + 4 fresh + 4 asking = 17 fits under 20.
  assert.equal(
    hostPressure(idle, limits, { held: [{ ageMs: 0, weight: 4 }], weight: 4 }),
    undefined,
  );
  // A second fresh holder makes 9 + 8 + 4 = 21: the third job waits although load1 alone is 9.
  assert.match(
    hostPressure(idle, limits, {
      held: [
        { ageMs: 0, weight: 4 },
        { ageMs: 0, weight: 4 },
      ],
      weight: 4,
    }) ?? '',
    /^projected load 21\.0 .* > 20\.0$/u,
  );
  // A holder load1 has long caught up with adds nothing beyond load1 itself.
  assert.ok(
    Math.abs(
      projectedLoad(15, { held: [{ ageMs: 600_000, weight: 4 }], weight: 4 }) -
        19,
    ) < 0.01,
  );
  assert.equal(projectedLoad(15), 15);
});

test('the gate hands its pressure probe the live holders, so a burst on a lagging load1 is held back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-gate-'));
  try {
    const seen: number[] = [];
    const probe = (admission: Admission) => {
      seen.push(admission.held.length);
      return hostPressure(
        { availableMb: 8000, cores: 16, load1: 9 },
        gateLimits({}),
        admission,
      );
    };
    const options = {
      deadlineMs: 50,
      dir,
      pollMs: 5,
      pressure: probe,
      slots: 16,
      weight: 4,
    };
    await withSlot(options, () =>
      withSlot(options, async () => {
        await assert.rejects(
          withSlot(options, async () => 'third'),
          { name: 'SlotTimeoutError' },
        );
      }),
    );
    assert.equal(seen[0], 1);
    assert.ok(seen.slice(1).every((held) => held === 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the gate lives outside every checkout and KRN fast takes a weight that fits defaultTestSlots checks', () => {
  assert.equal(
    hostGateDir({ XDG_STATE_HOME: '/state' }),
    '/state/krn/heavy-gate',
  );
  assert.equal(hostGateDir({ KRN_HEAVY_GATE_DIR: '/g' }), '/g');
  for (const cores of [4, 8, 12, 16, 32]) {
    const options = testSlotOptions('.', { XDG_STATE_HOME: '/state' }, cores);
    assert.equal(options.dir, '/state/krn/heavy-gate');
    assert.equal(options.slots, cores);
    assert.equal(
      Math.floor(options.slots / options.weight),
      defaultTestSlots(cores),
    );
    assert.equal(typeof options.pressure, 'function');
  }
  const pinned = testSlotOptions('.', {
    KRN_FAST_SLOTS: '3',
    KRN_FAST_SLOT_DIR: '/x',
  });
  assert.deepEqual(
    [pinned.slots, pinned.weight, pinned.pressure],
    [3, 1, undefined],
  );
  assert.equal(defaultJobWeight(16), 4);
});
