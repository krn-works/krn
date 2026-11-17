import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runJudge } from '../../evals/d23/screen.ts';
import {
  DEFAULT_MAX_SESSIONS,
  maxSessions,
  takeSessionSlot,
  withSessionSlot,
} from '../../evals/session-slot.ts';

const slotCli = fileURLToPath(
  new URL('../../evals/session-slot.ts', import.meta.url),
);

/** A stub claude that logs +1 on start and -1 on end, so the log's running sum is the live session count. */
function stubClaude(dir: string, log: string) {
  const path = join(dir, 'claude');
  writeFileSync(
    path,
    `#!/bin/sh\ncat >/dev/null\necho +1 >> ${log}\nsleep 0.4\necho -1 >> ${log}\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

const peak = (log: string) => {
  let live = 0;
  let max = 0;
  for (const l of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    live += Number(l);
    max = Math.max(max, live);
  }
  return max;
};

function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>) {
  const saved = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
}

test('the cap defaults to 4 and reads KRN_EVAL_MAX_SESSIONS', () => {
  assert.equal(DEFAULT_MAX_SESSIONS, 4);
  assert.equal(maxSessions({}), 4);
  assert.equal(maxSessions({ KRN_EVAL_MAX_SESSIONS: '2' }), 2);
  assert.equal(maxSessions({ KRN_EVAL_MAX_SESSIONS: 'x' }), 4);
  assert.equal(maxSessions({ KRN_EVAL_MAX_SESSIONS: '0' }), 4);
});

test('judge sessions never run more than N at once with N=2 on a stub claude', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-cap-'));
  try {
    const log = join(dir, 'log');
    writeFileSync(log, '');
    const claude = stubClaude(dir, log);
    await withEnv(
      {
        KRN_EVAL_MAX_SESSIONS: '2',
        KRN_EVAL_SLOT_DIR: join(dir, 'slots'),
      },
      () =>
        Promise.all(
          Array.from({ length: 6 }, () => runJudge(claude, 'prompt', dir)),
        ),
    );
    assert.equal(
      readFileSync(log, 'utf8').split('\n').filter(Boolean).length,
      12,
    );
    assert.equal(peak(log), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shell wrapper shares the cap across processes and prints the wait', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-cap-'));
  try {
    const log = join(dir, 'log');
    writeFileSync(log, '');
    const claude = stubClaude(dir, log);
    const env = {
      ...process.env,
      KRN_EVAL_MAX_SESSIONS: '2',
      KRN_EVAL_SLOT_DIR: join(dir, 'slots'),
    };
    const runs = Array.from(
      { length: 5 },
      () =>
        new Promise<{ code: number | null; err: string }>((done) => {
          const c = spawn(process.execPath, [slotCli, 'run', '--', claude], {
            env,
            stdio: ['pipe', 'ignore', 'pipe'],
          });
          let err = '';
          c.stderr.on('data', (d) => {
            err += d;
          });
          c.on('close', (code) => done({ code, err }));
          c.stdin.end('prompt');
        }),
    );
    const results = await Promise.all(runs);
    assert.ok(results.every((r) => r.code === 0));
    assert.equal(peak(log), 2);
    assert.ok(
      results.some((r) => /waiting for a session slot/.test(r.err)),
      'a waiting session prints the wait',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slot whose owner died is reclaimed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-cap-'));
  try {
    const slots = join(dir, 'slots');
    const env = {
      KRN_EVAL_MAX_SESSIONS: '1',
      KRN_EVAL_SLOT_DIR: slots,
    };
    spawnSync('mkdir', ['-p', slots]);
    // pid 2^22 is above the default pid_max range of every host this runs on.
    appendFileSync(join(slots, 'slot-0'), '4194304');
    assert.equal(await withSessionSlot(async () => 'ran', env), 'ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh slot file naming no owner is a slot being taken, not a dead one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-cap-'));
  try {
    const slots = join(dir, 'slots');
    const env = { KRN_EVAL_MAX_SESSIONS: '1', KRN_EVAL_SLOT_DIR: slots };
    mkdirSync(slots, { recursive: true });
    // What a reader saw between the create and the write of the old `wx` take: an empty slot file.
    writeFileSync(join(slots, 'slot-0'), '');
    let taken = false;
    const take = takeSessionSlot(env, 20).then((give) => {
      taken = true;
      return give;
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(taken, false, 'an empty fresh slot must not be reclaimed');
    rmSync(join(slots, 'slot-0'));
    (await take)();
    // An empty slot file that aged past the grace period is a crashed writer's leftover.
    writeFileSync(join(slots, 'slot-0'), '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(slots, 'slot-0'), old, old);
    assert.equal(await withSessionSlot(async () => 'ran', env), 'ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
