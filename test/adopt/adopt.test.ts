import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: runs the real `krn adopt` entry against a scratch git repository and
// checks the workflow against the inputs the shared workflow declares.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const shared = fileURLToPath(
  new URL('../../.github/workflows/project-ci.yml', import.meta.url),
);
const ref = 'a'.repeat(40);

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-adopt-'));
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return root;
}

function adopt(root: string, ...extra: string[]) {
  return spawnSync(
    process.execPath,
    [cli, 'adopt', root, '--ref', ref, ...extra],
    {
      encoding: 'utf8',
    },
  );
}

test('adopt writes the task directory, rules block, ignore entry and Check workflow call', () => {
  const root = scratch();
  const run = adopt(root, '--lint', 'npm run lint', '--test', 'npm test');
  assert.equal(run.status, 0, run.stderr);

  const tasks = readdirSync(join(root, 'tasks'));
  assert.equal(tasks.length, 1);
  assert.match(tasks[0] as string, /^t-[0-9a-z]+\.json$/u);

  const rules = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.match(rules, /krn-adoption:start/u);
  assert.match(rules, /ci \/ Check/u);
  assert.equal(lstatSync(join(root, 'CLAUDE.md')).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(root, 'CLAUDE.md')), 'AGENTS.md');
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.krn\/$/mu);

  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(
    workflow,
    new RegExp(
      `^ {2}ci:\\n {4}uses: krn-works/krn/\\.github/workflows/project-ci\\.yml@${ref}$`,
      'mu',
    ),
  );
  // Every input the call passes is declared by the shared workflow.
  const declared = readFileSync(shared, 'utf8');
  for (const name of ['lint', 'test'])
    assert.match(declared, new RegExp(`^ {6}${name}:$`, 'mu'));
  assert.match(workflow, /^ {6}lint: "npm run lint"$/mu);
  assert.doesNotMatch(workflow, /typecheck:/u);
});

test('adopt rerun changes nothing and keeps existing instructions', () => {
  const root = scratch();
  spawnSync('sh', ['-c', `printf '# Mine\\n' > "${root}/AGENTS.md"`]);
  assert.equal(adopt(root).status, 0);
  const first = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.match(first, /^# Mine\n/u);
  const again = adopt(root);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^wrote /mu);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), first);
  assert.equal(readdirSync(join(root, 'tasks')).length, 1);
});

test('adopt refuses a path that is not a git repository and a ref that is not a sha', () => {
  const plain = mkdtempSync(join(tmpdir(), 'krn-adopt-plain-'));
  const notRepo = adopt(plain);
  assert.equal(notRepo.status, 64);
  assert.match(notRepo.stderr, /not a git repository/u);
  const badRef = spawnSync(
    process.execPath,
    [cli, 'adopt', scratch(), '--ref', 'main'],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(badRef.status, 64);
  assert.match(badRef.stderr, /40-character/u);
});
