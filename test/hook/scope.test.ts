import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, judge, parseScope, taskId } from '../../src/hook/scope.ts';

const hook = fileURLToPath(new URL('../../src/hook/scope.ts', import.meta.url));
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
  for (const path of ['tasks/t-1.json'])
    assert.match(
      decide(write(`${root}/${path}`), worker('src/')) ?? '',
      /Refused/u,
      path,
    );
  // A red test that needs a harness file must not stay red: the write runs and is named.
  for (const path of [
    '.agents/skills/delivery-lead/SKILL.md',
    '.claude/settings.json',
    'AGENTS.md',
    'CLAUDE.md',
  ]) {
    const verdict = judge(write(`${root}/${path}`), worker('src/'));
    assert.equal(verdict.refusal, undefined, path);
    assert.match(verdict.note ?? '', new RegExp(path.replace('.', '\\.'), 'u'));
    assert.match(verdict.note ?? '', /only if a named test is red without it/u);
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
    "sed -i 's/a/b/' tasks/t-3.json",
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
      'Scope: .claude/settings.json autoCompactWindow or the context-gauge thresholds, delivery-lead skill text, their tests.',
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
  refused(w(`${main}/src/ci/ship.ts`));
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
  for (const ok of [`${lane}/src/a.ts`, `${main}/.krn/runs/lane-x/notes.md`])
    assert.equal(decide(w(ok), env), undefined, ok);
  // /tmp is outside the worktree for an Edit as for a Bash redirect.
  assert.match(decide(w('/tmp/x'), env) ?? '', /outside this lane/u);
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

test('a task id stands alone in a branch or path, so a slug that spells t- plus seven letters names no task', () => {
  assert.equal(taskId('verdict-evidence'), undefined);
  assert.equal(taskId('/repo/.krn/worktrees/verdict-evidence/tmp'), undefined);
  assert.equal(taskId('fix-t-abc1234'), 't-abc1234');
  assert.equal(taskId('/repo/.krn/worktrees/t-abc1234'), 't-abc1234');
});

test('a krn-lane subagent in the lead environment is refused a tracker write by payload agent_type (verbatim capture shape)', () => {
  const lead = { CLAUDE_PROJECT_DIR: root };
  const sub = {
    ...write(`${root}/tasks/x.json`),
    agent_id: 'a1b2c3',
    agent_type: 'krn-lane',
  };
  assert.match(decide(sub, lead) ?? '', /^Refused: .*tasks\/x\.json/u);
  assert.equal(decide(write(`${root}/tasks/x.json`), lead), undefined);
  assert.equal(
    decide({ ...sub, agent_type: 'Explore' }, lead),
    undefined,
    'other agent types are not workers',
  );
  const run = spawnSync('node', [hook], {
    input: JSON.stringify(sub),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Refused: .*tasks\/x\.json/u);
});

const main = '/r/main';
const subagent = (tool_name: string, tool_input: object, cwd = main) => ({
  agent_type: 'krn-lane',
  agent_id: 'a1',
  tool_name,
  cwd,
  tool_input,
});
const lead = { CLAUDE_PROJECT_DIR: main };

test('a lane subagent writing the main checkout is refused naming its worktree; worktree, .krn and lead pass', () => {
  const edit = subagent('Edit', { file_path: `${main}/src/x.ts` });
  assert.match(
    decide(edit, lead) ?? '',
    /^Refused: \/r\/main\/src\/x\.ts is in the main checkout.*\.krn\/worktrees\/<lane>/u,
  );
  const named = subagent(
    'Edit',
    { file_path: `${main}/src/x.ts` },
    `${main}/.krn/worktrees/lane-a`,
  );
  assert.match(decide(named, lead) ?? '', /\.krn\/worktrees\/lane-a\)/u);
  for (const path of [
    `${main}/.krn/worktrees/lane-a/src/x.ts`,
    `${main}/.krn/runs/w/n.md`,
  ])
    assert.equal(
      decide(subagent('Edit', { file_path: path }), lead),
      undefined,
      path,
    );
  const { agent_type, agent_id, ...leadPayload } = edit;
  assert.equal(decide(leadPayload, lead), undefined);
});

test('a lane subagent mutating Bash on the main checkout is refused; read-only Bash passes', () => {
  const run = (command: string) => decide(subagent('Bash', { command }), lead);
  for (const command of [
    `sed -i 's/a/b/' ${main}/src/x.ts`,
    `echo hi > ${main}/src/x.ts`,
    `rm ${main}/src/x.ts`,
    `mv ${main}/src/x.ts /tmp/y`,
    `cp /tmp/y ${main}/src/x.ts`,
    `git add src/x.ts`,
    `git checkout -- src/x.ts`,
    'git commit -m x',
  ])
    assert.match(run(command) ?? '', /^Refused/u, command);
  for (const command of [
    `cat ${main}/src/x.ts`,
    `grep -rn a ${main}/src`,
    'git status',
    'git log --oneline',
    `rm ${main}/.krn/tmp/x`,
    `ls ${main} > ${main}/.krn/runs/out`,
  ])
    assert.equal(run(command), undefined, command);
});

test('the main-checkout guard ignores heredoc bodies, quoted operators and relative paths after cd into the worktree', () => {
  const run = (command: string) => decide(subagent('Bash', { command }), lead);
  const own = `${main}/.krn/worktrees/lane-a`;
  for (const command of [
    // Heredoc body lines are data: neither `rm` nor `>` in them runs.
    `cat > ${main}/.krn/tmp/brief.md <<'EOF'\nrm src/x.ts\nthen a > b in prose\nEOF`,
    // `>` inside a quoted placeholder is text, not a redirect.
    `krn pr body --task '<task-id>' --verified '<command: verdict>' --out ${main}/.krn/tmp/b.md`,
    `echo "a > b" | grep a`,
    // Relative targets resolve against the cd that precedes them.
    `cd ${own} && echo x > src/out.ts`,
    `cd ${own} && git add -A && git commit -m x`,
    `cd ${own} && sed -i 's/a b/c/' src/x.ts`,
  ])
    assert.equal(run(command), undefined, command);
  for (const command of [
    `cd ${own} && echo x > ${main}/src/x.ts`,
    `cd ${own} && cd ../../.. && rm src/x.ts`,
    `echo "x" > "${main}/src/x.ts"`,
  ])
    assert.match(run(command) ?? '', /^Refused/u, command);
});

test('a worker redirect to an absolute path outside the worktree is refused with the scratch rule', () => {
  const env = worker('src/');
  for (const command of [
    'krn pr ship --title x > /tmp/x',
    'krn pr ship >> /tmp/ship.log 2>&1',
    'npm test 2>&1 | tee /tmp/t.log',
    'cd /tmp && echo x > out',
  ])
    assert.match(
      decide(bash(command), env) ?? '',
      /Scratch rule: write logs and drafts under \/r\/clone\/\.krn\/tmp/u,
      command,
    );
});

test('a worker redirect into .krn/tmp, the worktree, /dev/null or the harness scratchpad is allowed', () => {
  const env = { ...worker('src/'), CLAUDE_CODE_TMPDIR: '/h/claude' };
  for (const command of [
    'npm test > .krn/tmp/x.log 2>&1',
    `npm test > ${root}/.krn/tmp/x.log`,
    'npm test > /dev/null 2>&1',
    'npm test 2>/dev/null',
    'echo x > /h/claude/claude-1000/p/s/scratchpad/n.txt',
    'npm test | tee .krn/tmp/t.log',
  ])
    assert.equal(decide(bash(command), env), undefined, command);
});

test('a lead session may redirect anywhere', () => {
  assert.equal(
    decide(bash('krn pr ship > /tmp/x'), { CLAUDE_PROJECT_DIR: root }),
    undefined,
  );
});

test('Edit, Write and Bash outside the lane worktree get one refusal; lane-target admits one foreign path', () => {
  const wt = '/r/main/.krn/worktrees/lane';
  const env = {
    CLAUDE_PROJECT_DIR: wt,
    KRN_SESSION_CLASS: 'lane',
    KRN_TASK: 't-abcdefg',
    KRN_SCOPE: 'src/',
  };
  const call = (tool_name: string, tool_input: object) => ({
    tool_name,
    cwd: wt,
    tool_input,
  });
  const foreign = '/r/other/.node-version';
  for (const payload of [
    call('Edit', { file_path: foreign }),
    call('Write', { file_path: foreign }),
    call('Bash', { command: `echo 1 > ${foreign}` }),
    call('Bash', { command: `sed -i s/a/b/ ${foreign}` }),
    call('Bash', { command: 'git -C /r/other commit -m x' }),
    // /dev/.. starts with /dev/ but names the other repository.
    call('Write', { file_path: `/dev/..${foreign}` }),
    call('Bash', { command: `echo 1 > /dev/..${foreign}` }),
    // /dev/fd links to /proc/self/fd, so /dev/fd/../root reaches / while a lexical resolve says /dev/root.
    call('Write', { file_path: `/dev/fd/../root${foreign}` }),
    call('Bash', { command: `echo 1 > /dev/fd/../root${foreign}` }),
    call('Bash', { command: 'echo 1 > /dev/shm/x' }),
    // Every redirect operator, and a target on a continued line.
    call('Bash', { command: `echo 1 &> ${foreign}` }),
    call('Bash', { command: `echo 1 &>> ${foreign}` }),
    call('Bash', { command: `echo 1 >| ${foreign}` }),
    call('Bash', { command: `echo 1 >& ${foreign}` }),
    call('Bash', { command: `echo 1 1<> ${foreign}` }),
    call('Bash', { command: `echo 1 > \\\n${foreign}` }),
    // Home and variables expand where the hook cannot follow.
    call('Bash', { command: 'echo 1 > ~/x' }),
    call('Bash', { command: 'echo 1 > $HOME/x' }),
    call('Bash', { command: 'T=/r/other/a; echo 1 > $T' }),
    call('Bash', { command: 'cd $D && echo 1 > a' }),
    call('Bash', { command: 'cd -- /r/other && echo 1 > a' }),
  ])
    assert.match(
      decide(payload, env) ?? '',
      /Refused: .*outside this lane's worktree/u,
      JSON.stringify(payload),
    );
  assert.equal(
    decide(call('Edit', { file_path: `${wt}/src/a.ts` }), env),
    undefined,
  );
  for (const command of [
    'echo 1 > /dev/null',
    'echo 1 >&2',
    'npm test > .krn/tmp/x.log 2>&1',
    'echo 1 1>&-',
    'echo 1 > /dev/fd/2',
    'echo 1 &> /dev/null',
  ])
    assert.equal(decide(call('Bash', { command }), env), undefined, command);
  const admitted = { ...env, KRN_LANE_TARGET: '/r/other' };
  for (const payload of [
    call('Edit', { file_path: foreign }),
    call('Write', { file_path: foreign }),
    call('Bash', { command: `echo 1 > ${foreign}` }),
  ])
    assert.equal(decide(payload, admitted), undefined);
  assert.match(
    decide(call('Edit', { file_path: '/r/third/x' }), admitted) ?? '',
    /Refused/u,
  );
});

test('a path spelled through /dev/.. is judged where it lands: another repository is refused, descriptor devices pass', () => {
  const wt = '/r/main/.krn/worktrees/lane';
  const env = {
    CLAUDE_PROJECT_DIR: wt,
    KRN_SESSION_CLASS: 'lane',
    KRN_TASK: 't-abcdefg',
    KRN_SCOPE: 'src/',
    CLAUDE_CODE_TMPDIR: '/h/claude',
  };
  const call = (tool_name: string, tool_input: object) => ({
    tool_name,
    cwd: wt,
    tool_input,
  });
  for (const payload of [
    call('Write', { file_path: '/dev/../r/other/a.ts' }),
    call('Edit', { file_path: '/dev/./../r/other/a.ts' }),
    call('Write', { file_path: '/h/claude/../../r/other/a.ts' }),
    call('Bash', { command: 'echo x > /dev/../r/other/a.ts' }),
    call('Bash', { command: 'npm test 2>&1 | tee /dev/../r/other/t.log' }),
    call('Bash', { command: 'git -C /dev/../r/other commit -m x' }),
    call('Bash', { command: 'echo x > /dev/shm/x' }),
  ])
    assert.match(
      decide(payload, env) ?? '',
      /^Refused: .*outside this lane's worktree/u,
      JSON.stringify(payload),
    );
  for (const command of [
    'npm test > /dev/null 2>&1',
    'echo x > /dev/stderr',
    'echo x >/dev/fd/2',
    'echo x > /dev/tty',
  ])
    assert.equal(decide(call('Bash', { command }), env), undefined, command);
  assert.match(
    decide(bash('krn pr ship > /dev/../tmp/x'), worker('src/')) ?? '',
    /Scratch rule/u,
  );
});

test('a write through a symlink inside the worktree is judged where the link points', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'scope-link-')));
  try {
    const wt = join(base, 'main', '.krn', 'worktrees', 'lane');
    const other = join(base, 'other');
    mkdirSync(join(wt, 'src'), { recursive: true });
    mkdirSync(other);
    symlinkSync(other, join(wt, 'out'));
    symlinkSync(join(base, 'main'), join(base, 'alias'));
    // `..` after a link is taken beside the link's target, as the kernel walks it.
    mkdirSync(join(other, 'sub'));
    symlinkSync(join(other, 'sub'), join(wt, 'deep'));
    mkdirSync(join(base, 'main', '.krn', 'runs'), { recursive: true });
    symlinkSync(other, join(base, 'main', '.krn', 'runs', 'out'));
    const env = {
      CLAUDE_PROJECT_DIR: wt,
      KRN_SESSION_CLASS: 'lane',
      KRN_TASK: 't-abcdefg',
      KRN_SCOPE: 'src/',
    };
    const call = (tool_name: string, tool_input: object) => ({
      tool_name,
      cwd: wt,
      tool_input,
    });
    for (const payload of [
      call('Write', { file_path: join(wt, 'out', 'a.ts') }),
      call('Bash', { command: 'echo x > out/a.ts' }),
      call('Write', { file_path: `${wt}/deep/../a.ts` }),
      call('Bash', { command: 'echo x > deep/../a.ts' }),
      call('Bash', { command: 'cd out && echo x > a.ts' }),
      call('Bash', { command: 'cd deep/.. && echo x > a.ts' }),
      call('Write', {
        file_path: join(base, 'main', '.krn', 'runs', 'out', 'a.ts'),
      }),
      // Only the raw text of a descriptor device passes; `/dev/fd/5/..` follows fd 5 first.
      call('Bash', { command: 'echo x > /dev/fd/5/../1' }),
      call('Write', { file_path: '/dev/fd/5/../1' }),
      // `~user` expands where the hook cannot follow.
      call('Bash', { command: 'echo x > ~root/a.ts' }),
    ])
      assert.match(
        decide(payload, env) ?? '',
        /^Refused: .*outside this lane's worktree/u,
        JSON.stringify(payload),
      );
    // The worktree reached through a linked parent directory is still the worktree.
    const aliased = join(base, 'alias', '.krn', 'worktrees', 'lane');
    for (const [file_path, project] of [
      [join(wt, 'src', 'a.ts'), wt],
      [join(aliased, 'src', 'a.ts'), wt],
      [join(wt, 'src', 'a.ts'), aliased],
    ])
      assert.equal(
        decide(call('Write', { file_path }), {
          ...env,
          CLAUDE_PROJECT_DIR: project,
        }),
        undefined,
        `${file_path} from ${project}`,
      );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
