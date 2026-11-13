import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  decide,
  judge,
  parseScope,
} from '../../scripts/claude/worker-scope.ts';

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

test('tracker paths are denied to a worker; harness files are allowed and reported; other files are allowed', () => {
  for (const path of ['docs/program/roadmap.md', 'tasks/t-1.json'])
    assert.match(
      decide(write(`${root}/${path}`), worker('src/')) ?? '',
      /Refused/u,
      path,
    );
  // A red test that needs a harness file must not stay red: the write runs and is named.
  for (const path of [
    '.agents/skills/krn-lead/SKILL.md',
    '.claude/settings.json',
    'AGENTS.md',
    'CLAUDE.md',
  ]) {
    const verdict = judge(write(`${root}/${path}`), worker('src/'));
    assert.equal(verdict.refusal, undefined, path);
    assert.match(verdict.note ?? '', new RegExp(path.replace('.', '\\.'), 'u'));
  }
  assert.equal(
    judge(write(`${root}/AGENTS.md`), worker('AGENTS.md')).note,
    undefined,
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
    'cat a | tee tasks/t-2.json',
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
      decide(write(`${dir}/tasks/t-1.json`), env, 't-abc1234') ?? '',
      /Refused/u,
    );
    const goal = { ...env, KRN_LANE: 'slug' };
    assert.equal(decide(write(`${dir}/AGENTS.md`), goal, 'slug'), undefined);
    assert.match(
      decide(write(`${dir}/AGENTS.md`), env, 'slug') ?? '',
      /names no task/u,
    );
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
  // Prose entries name no path; a path inside prose still counts (D23 unit 470).
  assert.deepEqual(
    parseScope(
      'Scope: .claude/settings.json autoCompactWindow or the context-gauge thresholds, krn-lead skill text, their tests.',
    ),
    ['.claude/settings.json'],
  );
  assert.deepEqual(parseScope('Scope: the 27 files of `spike-h-c1.patch`.'), [
    'spike-h-c1.patch',
  ]);
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

test('KRN_TASK scopes a lane whose slug carries no task id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-scope-'));
  try {
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(
      join(dir, 'tasks/t-abc1234.json'),
      JSON.stringify({ body: ['Scope: src/.'] }),
    );
    const env = {
      CLAUDE_PROJECT_DIR: dir,
      KRN_SESSION_CLASS: 'lane',
      KRN_TASK: 't-abc1234',
    };
    assert.match(
      decide(write(`${dir}/tasks/t-1.json`), env, 'fix-x') ?? '',
      /Refused/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lane session may not write the main checkout outside its worktree and .krn/runs', () => {
  const main = '/r/main';
  const lane = `${main}/.krn/worktrees/lane-x`;
  const env = {
    CLAUDE_PROJECT_DIR: lane,
    KRN_SESSION_CLASS: 'lane',
    KRN_SCOPE: 'src/',
  };
  const w = (file_path: string, cwd = lane) => ({
    tool_name: 'Write',
    cwd,
    tool_input: { file_path },
  });
  const refused = (payload: unknown) =>
    assert.match(decide(payload, env) ?? '', /main checkout/u);
  refused(w(`${main}/src/ci/wait.ts`));
  refused(w(`${main}/.krn/worktrees/lane-other/src/a.ts`));
  refused(w('../../../src/a.ts'));
  refused({
    tool_name: 'Bash',
    cwd: main,
    tool_input: { command: 'echo x > src/a.ts' },
  });
  refused({
    tool_name: 'Edit',
    cwd: lane,
    tool_input: { file_path: `${main}/src/x.ts` },
  });
  for (const ok of [
    `${lane}/src/a.ts`,
    `${main}/.krn/runs/lane-x/notes.md`,
    '/tmp/x',
  ])
    assert.equal(decide(w(ok), env), undefined, ok);
  assert.match(
    decide(w(`${main}/src/a.ts`), {
      CLAUDE_PROJECT_DIR: lane,
      KRN_SESSION_CLASS: 'lane',
      KRN_LANE: 'goal',
    }) ?? '',
    /main checkout/u,
  );
  assert.equal(
    decide(w(`${main}/src/a.ts`), { CLAUDE_PROJECT_DIR: lane }),
    undefined,
  );
});
