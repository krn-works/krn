import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/bash-guards.ts', import.meta.url),
);
const run = (command: string) =>
  spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: JSON.stringify({
      tool_name: 'Bash',
      cwd: process.cwd(),
      tool_input: { command },
    }),
  });

test('an unbounded sleep loop is refused with the fix named', () => {
  for (const command of [
    'until grep -q verdict f; do sleep 5; done',
    'while ! test -f f; do sleep 2; done',
    'npm run fast > log 2>&1 & until grep -q "verdict" .krn/tmp/fast.log; do\n  sleep 30\ndone',
  ]) {
    const result = run(command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /background shell/u);
    assert.match(result.stderr, /fast PASS/u);
  }
});

test('a loop bounded by timeout and sleep-free commands pass', () => {
  for (const command of [
    "timeout 900 bash -c 'until grep -q x f; do sleep 5; done'",
    'sleep 5',
    'grep -q verdict f',
    'for f in a b; do echo $f; done',
    "cat <<'EOF'\nuntil x; do sleep 1; done\nEOF",
  ]) {
    const result = run(command);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
});
