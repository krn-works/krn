// How a hook caller finds its lane (ADR 0029 decision 2): `krn lane brief --task` reserves a manifest and prints
// the start command, `krn lane start --lane` moves it to started, the PreToolUse hook binds the subagent that
// runs that command, and scope judges every later write on the manifest. Real git, the real hook process, and
// the PreToolUse payload shape captured from the harness (test/claude/fixtures/pretooluse-bash-krn-lane.jsonl).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startLane } from '../../src/cli/lane.ts';
import { laneStartId } from '../../src/hook/lane-binding.ts';
import {
  createManifest,
  laneOfSession,
  listManifests,
  readManifest,
} from '../../src/lane/manifest.ts';
import { admitLanesOnAnyHost } from '../helpers/lane-host.ts';
import { git, startFixture } from '../helpers/lane-start.ts';

admitLanesOnAnyHost();
delete process.env.KRN_SESSION_CLASS;

const cli = fileURLToPath(new URL('../../src/cli/krn.mjs', import.meta.url));
const hook = fileURLToPath(new URL('../../src/hook/scope.ts', import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../claude/fixtures/pretooluse-bash-krn-lane.jsonl',
        import.meta.url,
      ),
    ),
    'utf8',
  ).trim(),
) as Record<string, unknown> & { tool_input: { command: string } };

function runHook(payload: unknown, project: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: project,
  };
  delete env.KRN_SESSION_CLASS;
  delete env.KRN_ROLE;
  delete env.KRN_LANE_ID;
  return spawnSync('node', [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
}

const call = (agent: string, tool_name: string, tool_input: object) => ({
  ...fixture,
  agent_id: agent,
  tool_name,
  tool_input,
});

test('the captured start command names its lane, in the plain forms and not in an expanded one', () => {
  assert.equal(laneStartId(fixture.tool_input.command), 'hook-binding-a1b2c3');
  assert.equal(laneStartId('krn lane start s --lane x-abc123'), 'x-abc123');
  assert.equal(
    laneStartId(
      'cd /r && bin/krn lane start s --lane=x-abc123 --task t-abc1234',
    ),
    'x-abc123',
  );
  assert.equal(laneStartId('krn lane start s --lane "$LANE"'), undefined);
  assert.equal(laneStartId('krn lane start s --task t-abc1234'), undefined);
  assert.equal(laneStartId('echo krn lane start s --lane x-abc123'), undefined);
});

test('brief reserves, start starts, the hook binds the subagent, scope judges it on the manifest', async (t) => {
  const { repo } = startFixture(t);
  // The fixture's finished lane has no manifest: it is the legacy lane, which this case is not about.
  git(
    repo,
    'worktree',
    'remove',
    '--force',
    join(repo, '.krn', 'worktrees', 'finished'),
  );
  const id = 't-abc1234';
  const briefRun = spawnSync(
    'node',
    [
      cli,
      'lane',
      'brief',
      '--task',
      id,
      '--slug',
      'bound',
      '--actor',
      'lane-x',
      '--root',
      repo,
    ],
    { input: 'Scope: src/\nDo the thing.', encoding: 'utf8' },
  );
  assert.equal(briefRun.status, 0, briefRun.stderr);
  const printed =
    /^Start: (bin\/krn lane start bound --task t-abc1234 --lane (bound-[0-9a-z]{6}) --actor lane-x)$/mu.exec(
      briefRun.stdout,
    );
  assert.ok(printed, briefRun.stdout.slice(0, 300));
  const laneId = printed[2] as string;
  const reserved = readManifest(repo, laneId);
  assert.equal(reserved?.phase.kind, 'reserved');
  assert.equal(reserved?.worktree, undefined);

  // A worker that has not started a lane writes nothing, and the refusal quotes its command.
  const agent = 'agent-bound-1';
  const unbound = runHook(
    call(agent, 'Bash', { command: `echo hi > ${repo}/out.txt` }),
    repo,
  );
  assert.equal(unbound.status, 2);
  assert.match(unbound.stderr, /bound to no lane.*echo hi > .*out\.txt/su);
  assert.equal(
    laneOfSession(call(agent, 'Bash', {}), {}, repo).kind,
    'unbound-worker',
  );

  // Its start command, read from the PreToolUse payload, binds it before the command runs.
  const start = runHook(
    call(agent, 'Bash', { command: printed[1] as string }),
    repo,
  );
  assert.equal(start.status, 0, start.stderr);
  assert.deepEqual(readManifest(repo, laneId)?.agents, [agent]);

  const { path: worktree } = await startLane([
    'bound',
    '--task',
    id,
    '--lane',
    laneId,
    '--actor',
    'lane-x',
    '--root',
    repo,
  ]);
  const started = readManifest(repo, laneId);
  assert.equal(started?.phase.kind, 'started');
  assert.equal(started?.worktree, worktree);
  assert.equal(started?.branch, 'bound');
  assert.equal(listManifests(repo).filter((m) => m.slug === 'bound').length, 1);
  const found = laneOfSession(call(agent, 'Bash', {}), {}, repo);
  assert.equal(found.kind, 'lane');

  const verdict = (tool: string, input: object) =>
    runHook({ ...call(agent, tool, input), cwd: worktree }, repo);
  // D4a: the worktree allows source and refuses the tracker.
  assert.equal(
    verdict('Write', { file_path: join(worktree, 'src', 'x.ts') }).status,
    0,
  );
  const tracker = verdict('Write', {
    file_path: join(worktree, 'tasks', `${id}.json`),
  });
  assert.equal(tracker.status, 2);
  assert.match(tracker.stderr, /tracker state.*krn task/su);
  // D4b: a foreign path and the main checkout are refused.
  for (const file of [
    join(repo, 'src', 'x.ts'),
    join(repo, 'tasks', `${id}.json`),
    '/etc/krn-x',
  ]) {
    const run = verdict('Write', { file_path: file });
    assert.equal(run.status, 2, file);
    assert.match(run.stderr, /outside lane/u, file);
  }
  // Another subagent of the same session stays unbound.
  assert.equal(
    runHook(
      {
        ...call('agent-other', 'Write', { file_path: join(worktree, 'a.ts') }),
        cwd: worktree,
      },
      repo,
    ).status,
    2,
  );
});

test('a start command that names no reserved lane binds nothing', (t) => {
  const { repo } = startFixture(t);
  const run = runHook(
    call('agent-1', 'Bash', { command: fixture.tool_input.command }),
    repo,
  );
  assert.equal(run.status, 0);
  assert.deepEqual(listManifests(repo), []);
});

test("a lane started before manifests existed keeps today's rule: its subagent still writes", (t) => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'krn-legacy-lane-')));
  t.after(() => rmSync(main, { recursive: true, force: true }));
  const worktree = join(main, '.krn', 'worktrees', 'old');
  mkdirSync(worktree, { recursive: true });
  const payload = {
    ...call('agent-old', 'Write', { file_path: join(worktree, 'src', 'x.ts') }),
    cwd: worktree,
  };
  assert.equal(laneOfSession(payload, {}, main).kind, 'legacy-lane');
  assert.equal(runHook(payload, main).status, 0);
  // Once that worktree has a manifest the lane is judged on it, not on the legacy rule.
  createManifest(
    main,
    {
      laneId: 'old-abc123',
      slug: 'old',
      branch: 'old',
      worktree,
      base: 'main',
      targets: [],
      actor: 'x',
      createdAt: new Date().toISOString(),
      agents: [],
    },
    { kind: 'started' },
  );
  assert.equal(laneOfSession(payload, {}, main).kind, 'unbound-worker');
  assert.equal(
    laneOfSession({}, { KRN_LANE_ID: 'old-abc123' }, main).kind,
    'lane',
  );
  assert.equal(laneOfSession({}, {}, main).kind, 'lead');
});
