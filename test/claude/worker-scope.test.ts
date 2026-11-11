import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, parseScope } from '../../scripts/claude/worker-scope.ts';

const hook = fileURLToPath(
  new URL('../../scripts/claude/worker-scope.ts', import.meta.url),
);
const root = '/r/clone';
const write = (file_path: string) => ({
  tool_name: 'Write',
  cwd: root,
  tool_input: { file_path },
});
const bash = (command: string) => ({
  tool_name: 'Bash',
  cwd: root,
  tool_input: { command },
});
const worker = (scope: string) => ({
  CLAUDE_PROJECT_DIR: root,
  KRN_ROLE: 'worker',
  KRN_SCOPE: scope,
});

test('a worker edit of tasks/x.json is denied, and allowed when Scope names tasks/', () => {
  const edit = write(`${root}/tasks/x.json`);
  assert.match(decide(edit, worker('src/')) ?? '', /^Refused: tasks\/x\.json/u);
  assert.equal(decide(edit, worker('Scope: src/, tasks/.')), undefined);
});

test('every guarded path is denied to a worker and files outside the guard are allowed', () => {
  for (const path of [
    'docs/program/roadmap.md',
    '.agents/skills/krn-lead/SKILL.md',
    '.claude/settings.json',
    'AGENTS.md',
    'CLAUDE.md',
  ])
    assert.match(
      decide(write(`${root}/${path}`), worker('src/')) ?? '',
      /Refused/u,
      path,
    );
  assert.equal(decide(write(`${root}/src/a.ts`), worker('src/')), undefined);
  assert.equal(decide(write(`${root}/docs/other.md`), worker('')), undefined);
  assert.equal(decide(write('/elsewhere/tasks/x.json'), worker('')), undefined);
});

test('NotebookEdit and visible Bash writes are held to the same scope', () => {
  const env = worker('src/');
  assert.match(
    decide(
      {
        tool_name: 'NotebookEdit',
        cwd: root,
        tool_input: { notebook_path: 'tasks/n.ipynb' },
      },
      env,
    ) ?? '',
    /Refused/u,
  );
  for (const command of [
    'echo x > tasks/t-1.json',
    'echo x >> AGENTS.md',
    'cat a | tee .claude/settings.json',
    "sed -i 's/a/b/' docs/program/roadmap.md",
  ])
    assert.match(decide(bash(command), env) ?? '', /Refused/u, command);
  for (const command of [
    'cat tasks/x.json',
    'echo x > src/a.txt',
    'ls > /dev/null',
    'npm test 2>&1',
  ])
    assert.equal(decide(bash(command), env), undefined, command);
});

test('the lead session, with neither marker, is never refused', () => {
  assert.equal(
    decide(write(`${root}/tasks/x.json`), { CLAUDE_PROJECT_DIR: root }),
    undefined,
  );
});

test('a lane session takes its Scope from the task record named by the branch, and a lane with no record is allowed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-scope-'));
  try {
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(
      join(dir, 'tasks/t-abc1234.json'),
      JSON.stringify({ body: ['Why: x.\nScope: src/, .agents/.'] }),
    );
    const env = { CLAUDE_PROJECT_DIR: dir, KRN_SESSION_CLASS: 'lane' };
    assert.equal(
      decide(write(`${dir}/.agents/a.md`), env, 't-abc1234'),
      undefined,
    );
    assert.match(
      decide(write(`${dir}/AGENTS.md`), env, 't-abc1234') ?? '',
      /Refused/u,
    );
    assert.equal(decide(write(`${dir}/AGENTS.md`), env, 'slug'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseScope reads a Scope line or a comma list', () => {
  assert.deepEqual(
    parseScope('Why: x\nScope: src/, `.agents/`, a.md.\nProof: y'),
    ['src/', '.agents/', 'a.md'],
  );
  assert.deepEqual(parseScope('src/,tasks/'), ['src/', 'tasks/']);
});

test('the hook process exits 2 with the reason for a refused worker call', () => {
  const run = (env: Record<string, string>) =>
    spawnSync('node', [hook], {
      input: JSON.stringify(write(`${root}/tasks/x.json`)),
      encoding: 'utf8',
      env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: root },
    });
  const denied = run({ KRN_ROLE: 'worker', KRN_SCOPE: 'src/' });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /Refused: tasks\/x\.json/u);
  assert.equal(run({ KRN_ROLE: 'worker', KRN_SCOPE: 'tasks/' }).status, 0);
});
