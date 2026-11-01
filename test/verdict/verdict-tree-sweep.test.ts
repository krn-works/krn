import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { redFirst } from '../../src/flow/repository.ts';
import * as sandbox from '../../src/verdict/sandbox.ts';
import {
  waitForCondition,
  waitForProcessExit,
} from '../helpers/condition-wait.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-verdict-tree-sweep-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.krn', 'tmp');
  mkdirSync(directory, { recursive: true });
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const ownerPath = (tree: string) =>
    join(directory, '.verdict-owners', `${basename(tree)}.json`);
  const tree = (name = 'verdict-orphan') => {
    const copy = join(directory, name);
    mkdirSync(copy);
    return copy;
  };
  const record = (
    copy: string,
    owner: { pid: number; start: string; quarantined?: boolean } = {
      pid: process.pid,
      start: '0',
    },
  ) => {
    mkdirSync(join(directory, '.verdict-owners'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(ownerPath(copy), JSON.stringify(owner));
  };
  return { root, directory, git, ownerPath, tree, record };
}

function sweep(...args: Parameters<typeof sandbox.sweepOrphanedVerdictTrees>) {
  assert.equal(typeof sandbox.sweepOrphanedVerdictTrees, 'function');
  return sandbox.sweepOrphanedVerdictTrees(...args);
}

test('sandbox exports the orphaned verdict tree sweep', () => {
  assert.equal(typeof sandbox.sweepOrphanedVerdictTrees, 'function');
});

test('the next allocation removes a SIGKILLed owner tree and record', async (t) => {
  const f = fixture(t);
  const script = join(f.root, 'owner.mjs');
  writeFileSync(
    script,
    `import * as sandbox from ${JSON.stringify(new URL('../../src/verdict/sandbox.ts', import.meta.url).href)};
process.on('message', () => {});
const copy = await sandbox.createWorktreeDirectory(${JSON.stringify(f.directory)}, ${JSON.stringify(f.root)});
process.send(copy);
`,
  );
  const child = fork(script, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let copy: string | undefined;
  let errors = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk) => (errors += chunk));
  child.stdout?.resume();
  child.on('message', (message) => {
    if (typeof message === 'string') copy = message;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await waitForProcessExit(child, 'the owned allocation child to exit');
  });
  const orphan = await waitForCondition(() => {
    assert.equal(child.exitCode, null, errors);
    return copy;
  }, 'the child allocation path');
  assert.ok(existsSync(orphan));
  assert.ok(child.pid);
  process.kill(child.pid, 'SIGKILL');
  const exit = await waitForProcessExit(child, 'the SIGKILLed owner to exit');
  assert.equal(exit.signal, 'SIGKILL');

  const allocated = await sandbox.createWorktreeDirectory(f.directory, f.root);

  assert.equal(existsSync(orphan), false, 'the dead owner tree must be swept');
  assert.equal(existsSync(f.ownerPath(orphan)), false);
  assert.deepEqual(
    readdirSync(f.directory).filter((entry) => entry.startsWith('verdict-')),
    [basename(allocated)],
  );
});

test('a matching live owner is kept and allocation records its proc start', async (t) => {
  const f = fixture(t);
  const copy = await sandbox.createWorktreeDirectory(f.directory, f.root);
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/u)[19];
  assert.deepEqual(JSON.parse(readFileSync(f.ownerPath(copy), 'utf8')), {
    pid: process.pid,
    start,
  });
  assert.equal(
    statSync(join(f.directory, '.verdict-owners')).mode & 0o777,
    0o700,
  );

  await sweep(f.root, f.directory);

  assert.ok(existsSync(copy));
  assert.ok(existsSync(f.ownerPath(copy)));
});

test('a live pid with a different start is a dead owner', async (t) => {
  const f = fixture(t);
  const copy = f.tree();
  f.record(copy);

  await sweep(f.root, f.directory);

  assert.equal(existsSync(copy), false);
  assert.equal(existsSync(f.ownerPath(copy)), false);
});

test('a dead quarantined owner is kept while a check scope is live', async (t) => {
  const f = fixture(t);
  const copy = f.tree();
  f.record(copy, { pid: process.pid, start: '0', quarantined: true });

  await sweep(f.root, f.directory, { scopeProbe: () => true });

  assert.ok(existsSync(copy));
  assert.ok(existsSync(f.ownerPath(copy)));
});

test('a dead quarantined owner is removed when no check scope is live', async (t) => {
  const f = fixture(t);
  const copy = f.tree();
  f.record(copy, { pid: process.pid, start: '0', quarantined: true });

  await sweep(f.root, f.directory, { scopeProbe: () => false });

  assert.equal(existsSync(copy), false);
  assert.equal(existsSync(f.ownerPath(copy)), false);
});

test('a failed scope probe keeps a dead quarantined owner', async (t) => {
  const f = fixture(t);
  const copy = f.tree();
  f.record(copy, { pid: process.pid, start: '0', quarantined: true });
  const writes: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string) => {
    writes.push(chunk);
    return true;
  });

  await sweep(f.root, f.directory, {
    scopeProbe: () => {
      throw new Error('fixture scope probe failed');
    },
  });

  assert.ok(existsSync(copy));
  assert.ok(existsSync(f.ownerPath(copy)));
  assert.equal(writes.length, 1);
  assert.match(writes.join(''), /fixture scope probe failed/u);
});

test('unrecorded trees older than 24 hours are removed', async (t) => {
  const f = fixture(t);
  const copy = f.tree();
  const now = Date.now();
  const old = new Date(now - 25 * 60 * 60 * 1000);
  utimesSync(copy, old, old);

  await sweep(f.root, f.directory, { now: () => now });

  assert.equal(existsSync(copy), false);
});

test('recent unrecorded trees are kept', async (t) => {
  const f = fixture(t);
  const copy = f.tree();
  const now = Date.now();
  const recent = new Date(now - 60 * 60 * 1000);
  utimesSync(copy, recent, recent);

  await sweep(f.root, f.directory, { now: () => now });

  assert.ok(existsSync(copy));
});

test('a dead registered worktree is removed from disk and git registration', async (t) => {
  const f = fixture(t);
  f.git(['init', '-q']);
  f.git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  const copy = f.tree();
  f.git(['worktree', 'add', '--quiet', '--detach', copy, 'HEAD']);
  f.record(copy);
  assert.ok(f.git(['worktree', 'list', '--porcelain']).includes(copy));

  await sweep(f.root, f.directory, { isOwnerAlive: () => false });

  assert.equal(existsSync(copy), false);
  assert.equal(existsSync(f.ownerPath(copy)), false);
  assert.equal(
    f.git(['worktree', 'list', '--porcelain']).includes(copy),
    false,
  );
});

test('normal registered worktree cleanup removes its owner record', async (t) => {
  const f = fixture(t);
  f.git(['init', '-q']);
  f.git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  const copy = await sandbox.createWorktreeDirectory(f.directory, f.root);
  await sandbox.addWorktree(f.root, copy, f.git(['rev-parse', 'HEAD']));
  assert.ok(existsSync(f.ownerPath(copy)));

  await sandbox.cleanupWorktrees(f.root, [copy]);

  assert.equal(existsSync(f.ownerPath(copy)), false);
  assert.deepEqual(readdirSync(f.directory), []);
});

test('records whose trees are gone are dropped', async (t) => {
  const f = fixture(t);
  const copy = join(f.directory, 'verdict-gone');
  f.record(copy);

  await sweep(f.root, f.directory);

  assert.equal(existsSync(f.ownerPath(copy)), false);
});

test('quarantine persists on the owner record without changing its identity', async (t) => {
  const f = fixture(t);
  const copy = await sandbox.createWorktreeDirectory(f.directory, f.root);
  const owner = JSON.parse(readFileSync(f.ownerPath(copy), 'utf8'));
  assert.equal(typeof sandbox.quarantineVerdictTree, 'function');

  sandbox.quarantineVerdictTree(copy);

  assert.deepEqual(JSON.parse(readFileSync(f.ownerPath(copy), 'utf8')), {
    ...owner,
    quarantined: true,
  });
});

for (const quarantined of [false, true]) {
  test(`red-first ${quarantined ? 'quarantines the owner on unconfirmed teardown' : 'removes the owner on confirmed cancellation'}`, async (t) => {
    const f = fixture(t);
    f.git(['init', '-q']);
    const commit = () => {
      f.git(['add', '--all']);
      f.git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ]);
      return f.git(['rev-parse', 'HEAD']);
    };
    writeFileSync(join(f.root, '.gitignore'), '.krn/\n');
    mkdirSync(join(f.root, 'test'));
    const path = join(f.root, 'test', 'probe.test.mjs');
    writeFileSync(
      path,
      "import { test } from 'node:test'; test('base', () => {});\n",
    );
    const base = commit();
    writeFileSync(
      path,
      "import { test } from 'node:test'; test('head', () => {});\n",
    );
    const head = commit();
    const error = quarantined
      ? new sandbox.TeardownUnconfirmed('fixture scope readback failed')
      : new Error('fixture confirmed cancellation');
    const controller = new AbortController();
    let copy: string | undefined;

    await assert.rejects(
      redFirst(
        f.root,
        base,
        head,
        controller.signal,
        async (_root, candidate) => {
          copy = candidate;
          if (!quarantined) controller.abort(error);
          throw error;
        },
      ),
      (caught) => caught === error,
    );

    assert.ok(copy);
    assert.equal(existsSync(copy), quarantined);
    assert.equal(existsSync(f.ownerPath(copy)), quarantined);
    if (quarantined)
      assert.equal(
        JSON.parse(readFileSync(f.ownerPath(copy), 'utf8')).quarantined,
        true,
      );
    else assert.deepEqual(readdirSync(f.directory), []);
  });
}

test('allocation sweeps once per directory even for concurrent allocations', async (t) => {
  const f = fixture(t);
  const orphan = f.tree();
  f.record(orphan);
  await Promise.all([
    sandbox.createWorktreeDirectory(f.directory, f.root),
    sandbox.createWorktreeDirectory(f.directory, f.root),
  ]);
  assert.equal(existsSync(orphan), false);
  const later = f.tree('verdict-later');
  f.record(later);

  await sandbox.createWorktreeDirectory(f.directory, f.root);

  assert.ok(existsSync(later), 'later allocations must not repeat the sweep');
  const other = fixture(t);
  const otherOrphan = other.tree();
  other.record(otherOrphan);
  await sandbox.createWorktreeDirectory(other.directory, other.root);
  assert.equal(existsSync(otherOrphan), false);
});

test('sweep errors produce one stderr line and allocation still succeeds', async (t) => {
  const f = fixture(t);
  for (const name of ['verdict-broken', 'verdict-invalid']) {
    const copy = f.tree(name);
    f.record(copy);
    writeFileSync(f.ownerPath(copy), '{invalid\njson');
  }
  const writes: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string) => {
    writes.push(chunk);
    return true;
  });

  const allocated = await sandbox.createWorktreeDirectory(f.directory, f.root);

  assert.ok(existsSync(allocated));
  assert.ok(existsSync(f.ownerPath(allocated)));
  assert.equal(writes.length, 1);
  assert.equal(writes.join('').trimEnd().split('\n').length, 1);
});
