// One lane walked through every verb on real git (ADR 0029 step 1b): task create, edit, dep add, lane start,
// the scope and Stop hooks, a commit, ship, drop. The task verbs run as the `krn` process; GitHub is replaced
// only where it is the receiver, by answers built from the verbatim captures in test/fixtures/gh (KRN-12).
// After each verb every store is snapshotted and exactly the stores it should change are named.
//
// Not asserted yet, because main gets them wrong; the ADR step named adds each case:
// - D3: a worker with no commit stops on another lane's ship record or merged sha (step 4).
// - D7: `krn lane drop` refuses a lane whose only task change is a staged deletion (step 2b).
// - D8: dep on a published record with a pending edit; a start whose task depends on a pending record (2a).
// - The manifest phase after ship (step 5): that snapshot omits manifests; drop retires the manifest.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { shipCommand } from '../../src/ci/ship.ts';
import { dropLane, startLane } from '../../src/cli/lane.ts';
import { bindOnLaneStart } from '../../src/hook/lane-binding.ts';
import { decide } from '../../src/hook/scope.ts';
import { stopHook } from '../../src/hook/stop.ts';
import { listManifests } from '../../src/lane/manifest.ts';
import { admitLanesOnAnyHost } from '../helpers/lane-host.ts';
import { git } from '../helpers/lane-start.ts';
import { capture } from '../receivers/capture.ts';

admitLanesOnAnyHost();
delete process.env.KRN_SESSION_CLASS;

const cli = fileURLToPath(new URL('../../src/cli/krn.mjs', import.meta.url));
const dependency = 't-dep0001';
const slug = 'wlane';

const seedDependency = `${JSON.stringify(
  {
    id: dependency,
    status: 'closed',
    resolution: { kind: 'done', ref: null, note: 'seed' },
    created: '2026-11-10',
    priority: 2,
    title: 'Seed dependency',
    after: [],
    body: ['Outcome: x'],
    acceptance: [{ verify: 'true', passes: true, exit: 0 }],
    kind: 'feature',
    area: 'widgets',
  },
  null,
  2,
)}\n`;

const taskBody =
  'Outcome: npm test exits 0 and prints 3 passing widget cache cases\nProof: node --test test/a.test.ts\nFiles: src/a.ts\n';

function fixture(t: test.TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-lifecycle-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'lifecycle test');
  git(repo, 'config', 'user.email', 'lifecycle@example.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(join(repo, 'tasks', `${dependency}.json`), seedDependency);
  writeFileSync(join(repo, '.gitignore'), '.krn/\n');
  writeFileSync(join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  writeFileSync(join(base, 'task-body.md'), taskBody);
  return { base, repo };
}

/** `krn <args>` as its own process with a clean environment; the last stdout line is the answer. */
function krn(repo: string, line: string): string {
  const run = spawnSync(process.execPath, [cli, ...line.split(' ')], {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeout: 30_000,
  });
  assert.equal(run.status, 0, `krn ${line}: ${run.stderr}`);
  return run.stdout.trim().split('\n').pop() ?? '';
}

type Stores = Record<string, string>;

/** Every store a lane verb may touch, as bytes or ids, keyed `<store>/<name>`. */
function snapshot(repo: string): Stores {
  const stores: Stores = {};
  const files = (store: string, dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir))
      stores[`${store}/${name}`] = readFileSync(join(dir, name), 'base64');
  };
  files('tasks', join(repo, 'tasks'));
  files('claims', join(repo, '.krn', 'task-claims'));
  files('ship', join(repo, '.krn', 'runs', 'ship'));
  files('manifests', join(repo, '.krn', 'runs', 'lanes'));
  const pending = spawnSync(
    'git',
    ['-C', repo, 'ls-tree', '-r', 'refs/krn/pending-tasks'],
    { encoding: 'utf8' },
  );
  for (const line of pending.status === 0 ? pending.stdout.split('\n') : []) {
    const [meta, name] = line.split('\t');
    if (name !== undefined) stores[`pending/${name}`] = meta ?? '';
  }
  stores.branches = git(
    repo,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/heads',
  );
  stores.worktrees = git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => /^(worktree|branch) /u.test(line))
    .join('\n');
  return stores;
}

/** The stores whose entries were added, removed or changed between two snapshots. */
function changed(before: Stores, after: Stores): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const stores = new Set<string>();
  for (const key of keys)
    if (before[key] !== after[key]) stores.add(key.split('/')[0] as string);
  return [...stores].sort();
}

const captured = (name: string) =>
  capture('fixtures/gh', name).streams.stdout?.toString('utf8') ?? '';

test('one lane walks every verb and each changes only its own stores', async (t) => {
  const { base, repo } = fixture(t);
  const worktree = join(repo, '.krn', 'worktrees', slug);
  let before = snapshot(repo);
  /** Runs one verb and returns the stores it changed. */
  const verb = async (
    run: () => unknown,
    options: { manifests?: boolean } = {},
  ) => {
    await run();
    const after = snapshot(repo);
    const touched = changed(before, after).filter(
      (store) => options.manifests !== false || store !== 'manifests',
    );
    before = after;
    return touched;
  };
  const pendingRecord = (id: string) =>
    JSON.parse(
      git(repo, 'show', `refs/krn/pending-tasks:tasks/${id}.json`),
    ) as { title: string; after: string[] };
  let id = '';

  await t.test('create writes the pending ref only', async () => {
    const touched = await verb(() => {
      id = krn(
        repo,
        `task create --title Lifecycle --kind feature --area widgets --body-file ${join(base, 'task-body.md')}`,
      );
    });
    assert.match(id, /^t-[a-z0-9]{7}$/u);
    assert.deepEqual(touched, ['pending']);
    assert.equal(pendingRecord(id).title, 'Lifecycle');
  });

  await t.test('edit writes the pending ref only', async () => {
    const touched = await verb(() =>
      krn(repo, `task edit ${id} --title Edited`),
    );
    assert.deepEqual(touched, ['pending']);
    assert.equal(pendingRecord(id).title, 'Edited');
  });

  await t.test(
    'dep add on a pending record writes the ref, not tasks/',
    async () => {
      const touched = await verb(() =>
        krn(repo, `task dep add ${id} --after ${dependency}`),
      );
      assert.deepEqual(touched, ['pending']);
      assert.deepEqual(pendingRecord(id).after, [dependency]);
      assert.deepEqual(readdirSync(join(repo, 'tasks')), [
        `${dependency}.json`,
      ]);
    },
  );

  await t.test(
    'start adds worktree, branch, claim, started manifest',
    async () => {
      const touched = await verb(() =>
        startLane([slug, '--task', id, '--root', repo]),
      );
      assert.deepEqual(touched, [
        'branches',
        'claims',
        'manifests',
        'pending',
        'worktrees',
      ]);
      const [manifest, ...others] = listManifests(repo);
      assert.equal(others.length, 0);
      assert.equal(manifest?.slug, slug);
      assert.equal(manifest?.task, id);
      assert.deepEqual(manifest?.phase, { kind: 'started' });
      assert.deepEqual(readdirSync(join(repo, '.krn', 'task-claims')), [
        `${id}.json`,
      ]);
      const carried = JSON.parse(
        readFileSync(join(worktree, 'tasks', `${id}.json`), 'utf8'),
      ) as { title: string; after: string[] };
      assert.equal(carried.title, 'Edited');
      assert.deepEqual(carried.after, [dependency]);
      assert.deepEqual(
        Object.keys(before).filter((key) => key.startsWith('pending/')),
        [],
      );
    },
  );

  const write = (file: string) => ({
    agent_type: 'krn-lane',
    agent_id: 'sub-1',
    tool_name: 'Write',
    cwd: worktree,
    tool_input: { file_path: file },
  });
  const hookEnv = { CLAUDE_PROJECT_DIR: repo };

  await t.test(
    'scope binds the subagent on its start command, allows the worktree and refuses tasks/ and foreign paths (D4a, D4b)',
    async () => {
      const touched = await verb(() => {
        const [manifest] = listManifests(repo);
        const laneId = manifest?.laneId as string;
        assert.equal(
          decide(write(join(worktree, 'src', 'x.ts')), hookEnv)?.slice(0, 8),
          'Refused:',
          'a subagent no manifest holds is unbound',
        );
        bindOnLaneStart(
          {
            ...write(''),
            tool_name: 'Bash',
            tool_input: {
              command: `bin/krn lane start ${slug} --lane ${laneId}`,
            },
          },
          repo,
        );
        assert.equal(
          decide(write(join(worktree, 'src', 'x.ts')), hookEnv),
          undefined,
        );
        for (const file of [
          join(worktree, 'tasks', `${id}.json`),
          join(repo, 'tasks', `${id}.json`),
          join(repo, 'src', 'x.ts'),
          '/etc/krn-foreign',
        ])
          assert.match(decide(write(file), hookEnv) ?? '', /^Refused:/u, file);
      });
      // Binding appends the agent to the manifest, which the snapshot counts as a manifest change.
      assert.deepEqual(touched, ['manifests']);
    },
  );

  await t.test('stop refuses a lane with no commit', async () => {
    let result: ReturnType<typeof stopHook> | undefined;
    const touched = await verb(() => {
      result = stopHook(
        JSON.stringify({ ...write(''), last_assistant_message: 'Done.' }),
        { CLAUDE_PROJECT_DIR: repo, KRN_TASK: id },
        slug,
      );
    });
    assert.equal(result?.code, 2);
    assert.match(result?.stderr ?? '', /no commit on this branch yet/u);
    assert.deepEqual(touched, []);
  });

  let head = '';
  await t.test('a commit moves only the lane branch', async () => {
    const touched = await verb(() => {
      writeFileSync(join(worktree, 'lane.txt'), 'lane\n');
      git(worktree, 'add', '.');
      git(worktree, 'commit', '-qm', `feat(lane): add a lane file (${id})`);
      head = git(worktree, 'rev-parse', 'HEAD');
    });
    assert.deepEqual(touched, ['branches']);
    assert.equal(git(repo, 'rev-parse', slug), head);
  });

  await t.test('ship merges through the receiver and records it', async () => {
    let merged: string | undefined;
    // `gh pr view` of PR #1131 with its head and merge commit rebound to this fixture; state, rollup and
    // auto-merge request stay as captured. Check-runs go through the same projection `--jq` applies.
    const gh = async (a: string[]): Promise<string> => {
      if (a[0] === 'api' && a[1]?.includes('/rules/branches/'))
        return captured('rules-branches-main-krn-works-krn');
      if (a[0] === 'api' && a[1]?.includes('/branches/'))
        return captured('branch-main-krn-works-krn');
      if (a[0] === 'api' && a[1]?.includes('/check-runs')) {
        const rows = JSON.parse(captured('check-runs-main-green')) as {
          check_runs: {
            id: number;
            name: string;
            app: { id: number };
            started_at: string;
            status: string;
            conclusion: string;
            details_url: string;
          }[];
        };
        return JSON.stringify(
          rows.check_runs.map((r) => ({
            id: r.id,
            name: r.name,
            appId: r.app.id,
            startedAt: r.started_at,
            status: r.status.toUpperCase(),
            conclusion: r.conclusion.toUpperCase(),
            detailsUrl: r.details_url,
          })),
        );
      }
      if (a[0] === 'run' && a[1] === 'list')
        return captured('run-list-head-completed');
      if (a[0] === 'pr' && a[1] === 'list') return '';
      if (a[0] === 'pr' && a[1] === 'create')
        return 'https://github.com/krn-works/krn/pull/1131\n';
      if (a[0] === 'pr' && a[1] === 'merge') {
        assert.ok(a.includes(head), 'the merge is pinned to the lane head');
        const tree = git(repo, 'rev-parse', `${head}^{tree}`);
        merged = git(
          repo,
          'commit-tree',
          tree,
          '-p',
          'origin/main',
          '-m',
          'squash',
        );
        git(repo, 'push', '-q', 'origin', `${merged}:refs/heads/main`);
        return '';
      }
      if (a[0] === 'pr' && a[1] === 'view') {
        const view = JSON.parse(captured('pr-1131-merged-view')) as {
          state: string;
          headRefOid: string;
          mergeCommit: { oid: string } | null;
        };
        view.headRefOid = head;
        if (merged === undefined) {
          view.state = 'OPEN';
          view.mergeCommit = null;
        } else view.mergeCommit = { oid: merged };
        return JSON.stringify(view);
      }
      throw new Error(`unexpected gh ${a.join(' ')}`);
    };
    const bodyFile = join(base, 'pr-body.md');
    writeFileSync(bodyFile, `## Why\n\nx\n\n## Verified\n\ny\n\nRefs: ${id}\n`);
    let verdict = '';
    const touched = await verb(
      async () => {
        verdict = await shipCommand(
          [
            '--worktree',
            worktree,
            '--title',
            `feat(lane): add a lane file (${id})`,
            '--body-file',
            bodyFile,
            '--repo',
            'krn-works/krn',
          ],
          { cwd: repo, gh, sleep: async () => {} },
        );
      },
      { manifests: false },
    );
    assert.ok(merged !== undefined);
    assert.match(verdict, new RegExp(`verdict: merged ${merged}`, 'u'));
    assert.deepEqual(touched, ['branches', 'ship', 'tasks']);
    const record = JSON.parse(
      readFileSync(join(repo, '.krn', 'runs', 'ship', `${slug}.json`), 'utf8'),
    );
    assert.deepEqual(
      { ...record, at: undefined },
      { branch: slug, sha: merged, head, task: id, at: undefined },
    );
  });

  await t.test(
    'drop releases the claim, removes worktree and branch',
    async () => {
      const touched = await verb(() => dropLane([slug, '--root', repo]));
      assert.deepEqual(touched, [
        'branches',
        'claims',
        'manifests',
        'worktrees',
      ]);
      assert.equal(existsSync(worktree), false);
      assert.equal(
        git(repo, 'branch', '--list', slug),
        '',
        'the lane branch is gone',
      );
      assert.equal(
        existsSync(join(repo, '.krn', 'task-claims', `${id}.json`)),
        false,
      );
      assert.ok(existsSync(join(repo, '.krn', 'runs', 'ship', `${slug}.json`)));
    },
  );
});
