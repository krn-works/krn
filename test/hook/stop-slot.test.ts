import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as stop from '../../src/hook/stop.ts';

const SLOT_HELD_ENV = 'KRN_TEST_SLOT_HELD';
const { inStopSlot, inspect, runTests, StopSlotTimeout } = stop;

const SLOT_MODULE = new URL('../../src/repo/slot-lock.ts', import.meta.url)
  .href;

/** Another process holds the only slot for `holdMs`; resolves once it holds it. */
function holder(dir: string, holdMs: number, marker?: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { withSlot } from '${SLOT_MODULE}';
       await withSlot({ dir: ${JSON.stringify(dir)}, slots: 1 }, async () => {
         process.stdout.write('held\\n');
         await new Promise((r) => setTimeout(r, ${holdMs}));
         ${marker ? `(await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, 'released');` : ''}
       });`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
  });
}

/** A repository with a commit on a branch past main that adds one test file. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'stop-slot-'));
  const git = (...args: string[]): void => {
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      { cwd: root, stdio: 'ignore' },
    );
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'x\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'work');
  mkdirSync(join(root, 'test'));
  writeFileSync(
    join(root, 'test/a.test.js'),
    "import test from 'node:test';\ntest('a', () => {});\n",
  );
  git('add', '.');
  git('commit', '-qm', 'add test');
  return root;
}

test('a stop test run waits for a held host slot and runs after its release', async () => {
  assert.equal(
    typeof inStopSlot,
    'function',
    'the Stop hook exports its slot runner',
  );
  const dir = mkdtempSync(join(tmpdir(), 'stop-slot-dir-'));
  const root = repo();
  try {
    const marker = join(dir, 'released');
    await holder(dir, 800, marker);
    const env = {
      [SLOT_HELD_ENV]: undefined,
      KRN_FAST_SLOT_DIR: dir,
      KRN_FAST_SLOTS: '1',
    };
    // The holder writes the marker just before it releases: work that sees it ran after the release.
    const ranAfterRelease = inStopSlot(root, () => existsSync(marker), env);
    assert.equal(ranAfterRelease, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stop test run inside fast (slot already held) does not queue', () => {
  assert.equal(
    typeof inStopSlot,
    'function',
    'the Stop hook exports its slot runner',
  );
  const dir = mkdtempSync(join(tmpdir(), 'stop-slot-dir-'));
  try {
    const env = { KRN_FAST_SLOT_DIR: dir, [SLOT_HELD_ENV]: '1' };
    assert.equal(
      inStopSlot('/nonexistent', () => 'ran', env),
      'ran',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slot deadline gives a named outcome that is not a test failure', async () => {
  assert.equal(
    typeof inStopSlot,
    'function',
    'the Stop hook exports its slot runner',
  );
  const dir = mkdtempSync(join(tmpdir(), 'stop-slot-dir-'));
  const root = repo();
  try {
    await holder(dir, 3000);
    const env = {
      ...process.env,
      [SLOT_HELD_ENV]: undefined,
      KRN_FAST_SLOT_DIR: dir,
      KRN_FAST_SLOTS: '1',
      KRN_FAST_SLOT_DEADLINE_MS: '300',
    };
    assert.throws(() => inStopSlot(root, () => [], env), StopSlotTimeout);
    const outcome = inspect(
      root,
      (dir, tests) => inStopSlot(dir, () => runTests(dir, tests), env),
      undefined,
      env,
    );
    assert.equal(outcome.ok, true);
    assert.match(outcome.slotTimeout ?? '', /no host test slot after/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
