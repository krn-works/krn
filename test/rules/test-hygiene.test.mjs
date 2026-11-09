import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Each entry is one file and one reason; there is no blanket allowlist.
const allowWait = new Map([
  [
    'test/hosts/codex-cancel.test.ts',
    'Polls a fake process tree under a deadline until the OS reports it.',
  ],
  [
    'test/hosts/codex-usage.test.ts',
    'Polls for the child start marker under a deadline.',
  ],
  [
    'test/hosts/codex-stale-scope.test.ts',
    'Polls the cgroup until the scope drains under a deadline.',
  ],
  [
    'test/worker/acceptance-checks-containment.test.ts',
    'Polls for a spawned process marker under a deadline.',
  ],
  [
    'test/worker/hardening-fixture.ts',
    'until() polls a condition under a deadline.',
  ],
  [
    'test/worker/recovery-fixture.ts',
    'until() polls a condition under a deadline.',
  ],
  [
    'test/worker/scope-bypass-fixture.ts',
    'until() polls a condition under a deadline.',
  ],
  [
    'test/worker/input-bounds-fixture.ts',
    'until() polls a condition under a deadline.',
  ],
  [
    'test/worker/state-trust-fixture.ts',
    'until() polls a condition under a deadline.',
  ],
  [
    'test/test-suite-shards-config.test.mjs',
    'The wait sits inside a fixture script string run by a child.',
  ],
]);
const allowSkip = new Map([
  [
    'test/gate-summary.test.ts',
    'Skips are fixture source strings that the gate summary parses.',
  ],
  [
    'test/tool-scope.test.ts',
    'Skips only when the probe re-enters itself, an environment guard.',
  ],
  [
    'test/task/claims-recovery.test.ts',
    'Skips only when running as root, an environment guard.',
  ],
  [
    'test/test-suite-shards.test.mjs',
    'todo: 0 is a TAP summary counter, not a todo test.',
  ],
]);

const waitPattern =
  /setTimeout\(\s*(?:resolve|done)\w*\b|\bdelay\(|\bsleep\(|while \(Date\.now\(\) </u;
const skipPattern = /\.skip\b|\bskip:|\.todo\b|\btodo:/u;
const suppressionPattern =
  /biome-ignore|@ts-expect-error|@ts-ignore|@ts-nocheck/u;
// Elapsed-time assertions flake on loaded runners; poll a condition under a deadline instead.
const wallClockPattern =
  /\b(?:Date|performance)\.now\(\)\s*-\s*[A-Za-z_$]|\bprocess\.hrtime\b/u;
// The runner's --test-timeout ceiling (scripts/lib/test-timeout.ts) bounds every test.
const testTimeoutPattern =
  /\b(?:test|it|describe|suite)(?:\.\w+)?\(\s*(['"`])(?:(?!\1)[^\\]|\\.)*\1\s*,\s*\{[^}]*?\btimeout\s*:/gu;

// Each entry is one file and one reason, as for waits.
const allowWallClock = new Map();
const allowTestTimeout = new Map([
  [
    'test/hosts/codex-registration.test.ts',
    'conditionTimeoutFor sizes each test to its 120 s condition waits, above the ceiling.',
  ],
  [
    'test/hosts/codex-usage.test.ts',
    'testTimeoutFor sizes each test to its spawned-process waits, above the ceiling.',
  ],
]);

/** Wall-clock deltas and per-test timeouts in one file's text, as "file:line message". */
export function clockProblems(file, text) {
  const problems = [];
  if (!allowWallClock.has(file)) {
    text.split('\n').forEach((line, index) => {
      if (wallClockPattern.test(line)) {
        problems.push(
          `${file}:${index + 1} wall-clock delta; assert on a condition or add a one-line allowlist reason`,
        );
      }
    });
  }
  if (!allowTestTimeout.has(file)) {
    for (const match of text.matchAll(testTimeoutPattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      problems.push(
        `${file}:${line} per-test timeout; the runner ceiling bounds every test`,
      );
    }
  }
  return problems;
}

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', 'test'],
  {
    cwd: root,
    encoding: 'utf8',
  },
)
  .split('\n')
  .filter(
    (file) =>
      /\.test\.[cm]?[jt]sx?$/u.test(file) && existsSync(`${root}/${file}`),
  );

function openTask(id) {
  const file = `${root}/tasks/${id}.json`;
  return (
    existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).status === 'open'
  );
}

test('tests never wait on the clock, skip without quarantine, or suppress without a reason', () => {
  const problems = [];
  for (const file of files) {
    if (file === 'test/rules/test-hygiene.test.mjs') continue;
    const lines = readFileSync(`${root}/${file}`, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const where = `${file}:${index + 1}`;
      if (waitPattern.test(line) && !allowWait.has(file)) {
        problems.push(
          `${where} fixed wait; poll a condition or add a one-line allowlist reason`,
        );
      }
      if (skipPattern.test(line) && !allowSkip.has(file)) {
        const near = lines.slice(Math.max(0, index - 3), index + 1).join('\n');
        const id = /quarantine: (t-[a-z0-9]+)/u.exec(near)?.[1];
        if (!id || !openTask(id)) {
          problems.push(
            `${where} skip/todo needs "quarantine: t-xxxx" naming an open task`,
          );
        }
      }
      if (
        suppressionPattern.test(line) &&
        !/(?:biome-ignore \S+|@ts-expect-error|@ts-ignore)\s*:?\s+\S{12,}/u.test(
          line,
        )
      ) {
        problems.push(`${where} suppression needs a reason on the same line`);
      }
    });
  }
  assert.deepEqual(problems, []);
});

test('tests never assert on wall-clock deltas or set a per-test timeout', () => {
  const problems = files
    .filter((file) => file !== 'test/rules/test-hygiene.test.mjs')
    .flatMap((file) =>
      clockProblems(file, readFileSync(`${root}/${file}`, 'utf8')),
    );
  assert.deepEqual(problems, []);
});

test('the clock rule reports exactly the seeded violations', () => {
  const seeded = [
    'const started = Date.now();\nassert.ok(Date.now() - started < 2000);',
    'const t0 = performance.now();\ntimes.push(performance.now() - t0);',
    'const t0 = process.hrtime.bigint();',
    "test('slow', {\n  timeout: 180_000,\n}, async () => {});",
    "t.test('inner', { skip: false, timeout: 5 }, () => {});",
    'describe("suite", { timeout: 1 }, () => {});',
  ].join('\n');
  const clean = [
    'const deadline = Date.now() + 10_000;',
    'while (Date.now() < deadline) {}',
    'const old = new Date(Date.now() - 3 * day);',
    "spawnSync('git', [], { encoding: 'utf8', timeout: 10_000 });",
    "test('fast', async () => {});",
    "test('object', { concurrency: 1 }, async () => {});",
  ].join('\n');
  assert.deepEqual(clockProblems('seeded.test.ts', seeded), [
    'seeded.test.ts:2 wall-clock delta; assert on a condition or add a one-line allowlist reason',
    'seeded.test.ts:4 wall-clock delta; assert on a condition or add a one-line allowlist reason',
    'seeded.test.ts:5 wall-clock delta; assert on a condition or add a one-line allowlist reason',
    'seeded.test.ts:6 per-test timeout; the runner ceiling bounds every test',
    'seeded.test.ts:9 per-test timeout; the runner ceiling bounds every test',
    'seeded.test.ts:10 per-test timeout; the runner ceiling bounds every test',
  ]);
  assert.deepEqual(clockProblems('clean.test.ts', clean), []);
});

test('hygiene allowlist entries still match a file that needs them', () => {
  const stale = [];
  for (const [map, pattern] of [
    [allowWait, waitPattern],
    [allowSkip, skipPattern],
    [allowWallClock, wallClockPattern],
    [allowTestTimeout, new RegExp(testTimeoutPattern.source, 'u')],
  ]) {
    for (const file of map.keys()) {
      if (
        !existsSync(`${root}/${file}`) ||
        !pattern.test(readFileSync(`${root}/${file}`, 'utf8'))
      ) {
        stale.push(file);
      }
    }
  }
  assert.deepEqual(stale, []);
});

// A polled JSONL log can end in a line its writer is still appending;
// trim() keeps that partial line, so readers drop the unterminated tail.
const partialJsonlPattern =
  /\.trim\(\)\s*\.split\('\\n'\)(?:\s*\.filter\(Boolean\))?\s*\.map\(\(\w+\) => JSON\.parse/u;

test('JSONL readers keep only newline-terminated rows', () => {
  const offenders = files.filter(
    (file) =>
      file !== 'test/rules/test-hygiene.test.mjs' &&
      partialJsonlPattern.test(readFileSync(`${root}/${file}`, 'utf8')),
  );
  assert.deepEqual(
    offenders,
    [],
    "use .split('\\n').slice(0, -1) instead of .trim().split('\\n')",
  );
});

test('partial JSONL pattern rejects trim-split readers and accepts terminated ones', () => {
  assert.ok(
    partialJsonlPattern.test(
      "text.trim()\n  .split('\\n')\n  .filter(Boolean)\n  .map((line) => JSON.parse(line))",
    ),
  );
  assert.ok(
    !partialJsonlPattern.test(
      "text.split('\\n')\n  .slice(0, -1)\n  .map((line) => JSON.parse(line))",
    ),
  );
});

// Worker code calls systemctl dozens of times per test file; a node stub
// costs ~120 ms of startup per call against ~9 ms in sh (t-3p3xp7z).
const nodeScopeStub =
  /(?:\bsystemctl|['"]systemd-run['"])\s*:\s*[`'"]#!\/usr\/bin\/env node/u;

test('systemd stubs in test fixtures run in sh, not node', () => {
  const sources = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'test'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\n')
    .filter(
      (file) =>
        /\.[cm]?[jt]s$/u.test(file) &&
        file !== 'test/rules/test-hygiene.test.mjs' &&
        existsSync(`${root}/${file}`),
    );
  const offenders = sources.filter((file) =>
    nodeScopeStub.test(readFileSync(`${root}/${file}`, 'utf8')),
  );
  assert.deepEqual(
    offenders,
    [],
    'use systemctlStub from test/worker/systemctl-stub.ts',
  );
  assert.ok(nodeScopeStub.test('systemctl: `#!/usr/bin/env node\n'));
  assert.ok(!nodeScopeStub.test("systemctl: '#!/bin/sh\\n'"));
});

// Each worker fixture setup starts a driver (~2.5 s); scenarios run one
// after another in a single test queue on that cost, so independent
// setups run as concurrent subtests (t-ed32603).
const loopedSetup = /\bfor \([^{}]*?\) \{\n\s*const \w+ = await setup\(t\)/u;

/** Top-level tests that await more than one fixture setup in sequence. */
export function serialSetups(file, text) {
  const problems = [];
  let offset = 0;
  for (const block of text.split(/\n(?=test\()/u)) {
    const line = text.slice(0, offset).split('\n').length;
    offset += block.length + 1;
    if (!block.startsWith('test(')) continue;
    const head = block.slice(0, block.indexOf('=>'));
    const setups = block.match(/await setup\(t\)/gu)?.length ?? 0;
    if (!/concurrency/u.test(head) && (setups > 1 || loopedSetup.test(block))) {
      problems.push(
        `${file}:${line} sequential fixture setups; run them as t.test subtests under { concurrency: 6 }`,
      );
    }
  }
  return problems;
}

test('worker and task tests run independent fixture setups concurrently', () => {
  const problems = files
    .filter((file) => /^test\/(?:worker|task)\//u.test(file))
    .flatMap((file) =>
      serialSetups(file, readFileSync(`${root}/${file}`, 'utf8')),
    );
  assert.deepEqual(problems, []);
});

test('the serial setup rule reports exactly the seeded violations', () => {
  const seeded = [
    "import x from 'y';",
    "test('loop', async (t) => {",
    '  for (const a of [1, 2]) {',
    '    const s = await setup(t);',
    '  }',
    '});',
    "test('two', async (t) => {",
    '  const s = await setup(t);',
    '  const p = await setup(t);',
    '});',
    "test('one', async (t) => {",
    '  const s = await setup(t);',
    '});',
    "test('fanned', {",
    '  concurrency: 6,',
    '}, async (t) => {',
    '  for (const a of [1, 2]) {',
    '    t.test(String(a), async (t) => {',
    '      const s = await setup(t);',
    '    });',
    '  }',
    '});',
  ].join('\n');
  assert.deepEqual(serialSetups('seeded.test.ts', seeded), [
    'seeded.test.ts:2 sequential fixture setups; run them as t.test subtests under { concurrency: 6 }',
    'seeded.test.ts:7 sequential fixture setups; run them as t.test subtests under { concurrency: 6 }',
  ]);
});
