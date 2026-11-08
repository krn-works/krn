import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Local Claude settings hold "Don't ask again" permission grants; the
// repository itself must ignore them, so a clone without the operator's
// global excludes (CI runner, worker host) never commits them.
test('repository .gitignore ignores local Claude settings without global excludes', () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: '/nonexistent',
  };
  delete env.XDG_CONFIG_HOME;
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.excludesFile=',
      'check-ignore',
      '-v',
      '--no-index',
      '.claude/settings.local.json',
    ],
    { cwd: root, env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `not ignored: ${result.stderr}`);
  assert.match(result.stdout, /^\.gitignore:\d+:/);
});
