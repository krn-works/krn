import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

test('project tools ignore nested worktree state', {
  skip: process.env.KRN_SCOPE_PROBE === '1',
}, async () => {
  const root = process.cwd();
  const fixture = path.join(
    root,
    '.krn',
    'worktrees',
    `scope-probe-${process.pid}`,
  );
  await mkdir(fixture, { recursive: true });
  await writeFile(
    path.join(fixture, 'failing.test.ts'),
    "import assert from 'node:assert/strict'; assert.fail('worktree test leaked into project tools');\n",
  );
  await writeFile(
    path.join(fixture, 'type-error.ts'),
    'const value: string = 42;\n',
  );

  try {
    const commands = [
      ['npm', ['test']],
      ['npm', ['run', 'check']],
      ['npm', ['run', 'lint']],
    ] as const;

    for (const [command, args] of commands) {
      const result = spawnSync(command, args, {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: '',
          KRN_SCOPE_PROBE: '1',
        },
        timeout: 120_000,
      });
      assert.equal(
        result.error,
        undefined,
        `${command} ${args.join(' ')} failed to start: ${result.error?.message}`,
      );
      assert.equal(
        result.status,
        0,
        `${command} ${args.join(' ')} scanned .krn state:\n${result.stdout}\n${result.stderr}`,
      );
      if (process.env.CI === 'true') {
        const skips = result.stdout
          .split(/\r?\n/u)
          .map((line) => line.replace(/^#\s?/u, ''))
          .filter((line) => line.startsWith('SKIP(isolation):'));
        for (const skip of skips) process.stdout.write(`${skip}\n`);
      }
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
