import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { decide as commitDecide } from '../../src/hook/commit-format.ts';
import { commandsOf } from '../../src/hook/shell-reader.ts';
import { decide as deleteDecide } from '../../src/hook/unpushed-delete.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ).trim();

function laneWithOpenTask(t: TestContext) {
  const repo = mkdtempSync(join(tmpdir(), 'krn-opaque-delete-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '--allow-empty', '-qm', 'Base');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'switch', '-qc', 'lane');
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(join(repo, 'tasks', 't-ab12.json'), '{"status":"open"}');
  git(repo, 'add', 'tasks');
  git(repo, 'commit', '-qm', 'Work', '-m', 'Ticket: t-ab12');
  git(repo, 'switch', '-q', 'main');
  return repo;
}

const commit = (command: string) =>
  commitDecide({ tool_name: 'Bash', tool_input: { command } }) ?? '';

test('a heredoc with an explicit stdout self-duplication does not let a commit subject through', () => {
  const command = `git commit -m "$(cat <<'MESSAGE' 1>&1
Update stuff
MESSAGE
)"`;
  assert.match(commit(command), /1>&1/u);
  assert.match(commit(command), /-m '<subject>'/u);
});

test('an opaque commit with a message file is not refused', () => {
  assert.equal(commit('eval git commit -F msg.txt'), '');
});

test('a coprocess branch deletion is refused and names coproc', (t) => {
  const repo = laneWithOpenTask(t);
  const check = (command: string) =>
    deleteDecide({ cwd: repo, tool_input: { command } }) ?? '';
  assert.match(check('git branch -D lane'), /open task t-ab12/u);
  assert.match(check('coproc git branch -D lane'), /coproc/u);
  assert.match(check('eval "git push origin --delete lane"'), /eval/u);
  assert.match(check('git push origin :lane 3>&1'), /3>&1/u);
});

test('an opaque command that deletes nothing is not refused', (t) => {
  const repo = laneWithOpenTask(t);
  const result = deleteDecide({
    cwd: repo,
    tool_input: { command: 'coproc git status' },
  });
  assert.equal(result, undefined);
});

test('the reader marks the constructs it does not model and keeps the usual ones plain', () => {
  const opaque = (text: string) => commandsOf(text)[0]?.opaque;
  assert.equal(opaque('coproc git status'), 'coproc');
  assert.equal(opaque('eval ls'), 'eval');
  assert.match(opaque('echo $(cat <<E 1>&1\nx\nE\n)') ?? '', /1>&1/u);
  assert.match(opaque("echo $'\\q'") ?? '', /escape/u);
  assert.equal(opaque('git status 2>&1'), undefined);
  assert.equal(opaque("echo $'a\\n'"), undefined);
});
