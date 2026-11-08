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
    'test/test-suite-shards.test.mjs',
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

test('hygiene allowlist entries still match a file that needs them', () => {
  const stale = [];
  for (const [map, pattern] of [
    [allowWait, waitPattern],
    [allowSkip, skipPattern],
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
