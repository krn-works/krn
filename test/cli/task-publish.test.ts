import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { publishCommand } from '../../src/cli/task-publish.ts';
import { pendingTaskFiles } from '../../src/task/pending.ts';
import { withCategories } from '../task/task-fixture.ts';

delete process.env.KRN_SESSION_CLASS;
// KRN-12: a real origin, a real main checkout and a real `krn task create`; only gh is faked.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const deployWorkflow = `on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: echo ship
`;

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-publish-')));
  const origin = join(base, 'origin.git');
  const main = join(base, 'main');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, main);
  git(main, 'config', 'user.name', 'publish test');
  git(main, 'config', 'user.email', 'publish@example.invalid');
  git(main, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(main, '.gitignore'), '.krn/\n');
  mkdirSync(join(main, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(main, '.github', 'workflows', 'deploy.yml'),
    deployWorkflow,
  );
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'seed');
  git(main, 'push', '-q', 'origin', 'main');
  const created = spawnSync(
    process.execPath,
    [cli, 'task', ...withCategories(['create', '--title', 'Pending record'])],
    { cwd: main, encoding: 'utf8' },
  );
  assert.equal(created.status, 0, created.stderr);
  assert.equal(
    pendingTaskFiles(main).size,
    1,
    'the record waits on the pending ref',
  );
  return { base, origin, main };
}

test('publish refuses with exit 82 before any push when the base deploys on push without an acknowledgement', async () => {
  const { base, origin, main } = fixture();
  try {
    const calls: string[][] = [];
    const gh = async (a: string[]): Promise<string> => {
      calls.push(a);
      return '';
    };
    await assert.rejects(
      publishCommand([], { cwd: main, gh, sleep: async () => {} }),
      (error: Error & { exitCode?: number }) => {
        assert.equal(error.exitCode, 82, error.message);
        assert.match(error.message, /deploy\.yml deploys on a push to main/u);
        return true;
      },
    );
    assert.deepEqual(
      git(origin, 'branch', '--format=%(refname:short)').split('\n'),
      ['main'],
      'no lane branch reached the origin',
    );
    assert.equal(
      calls.some(
        (a) => a[0] === 'pr' && (a[1] === 'create' || a[1] === 'merge'),
      ),
      false,
    );
    assert.equal(pendingTaskFiles(main).size, 1, 'the record stays pending');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a publish refused before the push removes its lane so the retry reaches ship again without a lane drop', async () => {
  const { base, origin, main } = fixture();
  try {
    const gh = async (): Promise<string> => '';
    const refused = (error: Error & { exitCode?: number }) => {
      assert.equal(error.exitCode, 82, error.message);
      return true;
    };
    await assert.rejects(
      publishCommand([], { cwd: main, gh, sleep: async () => {} }),
      refused,
    );
    assert.equal(
      git(main, 'worktree', 'list', '--porcelain').includes('task-records-'),
      false,
      'the failed publish removed its worktree',
    );
    assert.equal(
      git(main, 'branch', '--list', 'task-records-*'),
      '',
      'the failed publish removed its branch',
    );
    // A second attempt starts a lane again (it exited 64 "already exists" before) and is refused by ship, not by the lane.
    await assert.rejects(
      publishCommand([], { cwd: main, gh, sleep: async () => {} }),
      refused,
    );
    assert.equal(pendingTaskFiles(main).size, 1, 'the record stays pending');
    assert.equal(git(origin, 'branch', '--format=%(refname:short)'), 'main');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
