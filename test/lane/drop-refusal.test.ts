import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dropLane } from '../../src/cli/lane.ts';
import { commandErrorExitCode } from '../../src/cli-kit/command-error.ts';
import { git } from '../helpers/lane-start.ts';

// KRN-12: real git, a real bare origin. One rule: a commit no remote ref holds, or any change under tasks/.
const ident = ['-c', 'user.name=Test', '-c', 'user.email=t@example.invalid'];

function fixture(t: test.TestContext): {
  repo: string;
  tree: (s: string) => string;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-drop-refusal-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', origin);
  git(base, 'init', '-qb', 'main', repo);
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(join(repo, 'tasks', 't-old0001.json'), '{}\n');
  git(repo, 'add', '.');
  git(repo, ...ident, 'commit', '-qm', 'seed');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  return {
    repo,
    tree: (slug) => {
      const path = join(repo, '.krn', 'worktrees', slug);
      git(repo, 'worktree', 'add', '-q', '-b', slug, path);
      return path;
    },
  };
}

async function refused(repo: string, slug: string, ...flags: string[]) {
  try {
    await dropLane([slug, '--root', repo, ...flags]);
  } catch (error) {
    assert.equal(commandErrorExitCode(error), 65);
    return (error as Error).message;
  }
  return assert.fail('drop was not refused');
}

test('an unpushed lane commit refuses the drop, naming the commit and --force', async (t) => {
  const { repo, tree } = fixture(t);
  const path = tree('ahead');
  writeFileSync(join(path, 'a.txt'), 'a');
  git(path, 'add', '.');
  git(path, ...ident, 'commit', '-qm', 'ahead');
  const message = await refused(repo, 'ahead');
  assert.ok(message.includes(git(path, 'rev-parse', '--short=12', 'HEAD')));
  assert.match(message, /--force/u);
  assert.ok(existsSync(path));
  await dropLane(['ahead', '--root', repo, '--force']);
  assert.equal(existsSync(path), false);
  assert.equal(git(repo, 'branch', '--list', 'ahead'), '');
});

test('a commit made on a detached HEAD refuses the drop', async (t) => {
  const { repo, tree } = fixture(t);
  const path = tree('loose');
  git(path, 'checkout', '-q', '--detach');
  writeFileSync(join(path, 'a.txt'), 'a');
  git(path, 'add', '.');
  git(path, ...ident, 'commit', '-qm', 'detached');
  assert.match(await refused(repo, 'loose'), /commit .* --force/u);
  assert.ok(existsSync(path));
});

test('a staged deletion of a task record refuses the drop, on a branch and detached', async (t) => {
  const { repo, tree } = fixture(t);
  const path = tree('del');
  git(path, 'rm', '-q', 'tasks/t-old0001.json');
  assert.match(await refused(repo, 'del'), /tasks\/t-old0001\.json.*--force/u);
  const other = tree('deldet');
  git(other, 'checkout', '-q', '--detach');
  git(other, 'rm', '-q', 'tasks/t-old0001.json');
  assert.match(await refused(repo, 'deldet'), /tasks\/t-old0001\.json/u);
});

test('an untracked or edited task file refuses the drop', async (t) => {
  const { repo, tree } = fixture(t);
  const path = tree('fresh');
  writeFileSync(join(path, 'tasks', 't-new0001.json'), '{}\n');
  assert.match(await refused(repo, 'fresh'), /tasks\/t-new0001\.json/u);
  const edited = tree('edited');
  writeFileSync(join(edited, 'tasks', 't-old0001.json'), '{"a":1}\n');
  assert.match(await refused(repo, 'edited'), /tasks\/t-old0001\.json/u);
});

test('a clean lane whose commit is pushed drops, and so does an untouched one', async (t) => {
  const { repo, tree } = fixture(t);
  const path = tree('done');
  writeFileSync(join(path, 'a.txt'), 'a');
  git(path, 'add', '.');
  git(path, ...ident, 'commit', '-qm', 'pushed');
  git(path, 'push', '-q', 'origin', 'done');
  const clean = tree('clean');
  assert.match(await dropLane(['done', '--root', repo]), /^dropped lane done/u);
  assert.match(
    await dropLane(['clean', '--root', repo]),
    /^dropped lane clean/u,
  );
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(clean), false);
});
