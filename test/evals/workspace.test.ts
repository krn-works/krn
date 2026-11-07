import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { failure, files, fixture, git, gitEnv } from './workspace-fixture.ts';

test('eval prepare creates only depth-one base objects and leaves the source byte-identical', async () => {
  const f = await fixture();
  try {
    const before = await files(join(f.source, '.git'));
    const result = f.prepare();
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.experiment, f.value.id);
    assert.equal(output.tasks.length, 2);
    for (const task of output.tasks) {
      const repo = join(f.root, f.value.id, task.id, 'repo');
      assert.equal(task.path, repo);
      assert.equal(task.base, f.base);
      const all = git(repo, [
        'cat-file',
        '--batch-all-objects',
        '--batch-check',
      ])
        .split('\n')
        .map((line) => line.split(' ')[0])
        .sort();
      const reachable = git(repo, ['rev-list', '--objects', f.base])
        .split('\n')
        .map((line) => line.split(' ')[0])
        .sort();
      assert.deepEqual(all, reachable);
      assert.equal(task.objectCount, all.length);
      for (const absent of [f.parent, f.exemplar, f.dangling])
        assert.notEqual(
          spawnSync('git', ['-C', repo, 'cat-file', '-e', absent], {
            env: gitEnv,
          }).status,
          0,
        );
      assert.equal(git(repo, ['rev-list', '--all']), f.base);
      assert.equal(git(repo, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
      assert.equal(git(repo, ['rev-parse', 'main']), f.base);
      assert.equal(git(repo, ['rev-parse', 'origin/main']), f.base);
      assert.equal(git(repo, ['remote']), '');
      assert.equal(git(repo, ['tag']), '');
      assert.equal(git(repo, ['reflog', 'show', '--all']), '');
      assert.equal(git(repo, ['status', '--porcelain=v1']), '');
      assert.equal(await readFile(join(repo, 'base.txt'), 'utf8'), 'base\n');
      await assert.rejects(readdir(join(repo, '.git', 'hooks')), {
        code: 'ENOENT',
      });
    }
    assert.deepEqual(await files(join(f.source, '.git')), before);
    failure(f.prepare(), 65, /exist/u);
  } finally {
    await f.cleanup();
  }
});
test('eval prepare refuses unsafe roots, existing task directories and symlink escapes', async (t) => {
  for (const kind of [
    'empty .git directory',
    '.git HEAD',
    '.git file',
    '.krn',
    'root marker',
    'relative',
    'source',
    'experiment',
    'existing',
    'alias',
  ]) {
    await t.test(kind, async () => {
      const f = await fixture();
      try {
        let root = f.root;
        if (kind === 'empty .git directory') {
          await mkdir(join(f.directory, '.git'));
          root = join(f.directory, 'parent', 'child');
        } else if (kind === '.git HEAD') {
          await mkdir(join(f.directory, '.git'));
          await writeFile(
            join(f.directory, '.git', 'HEAD'),
            'ref: refs/heads/main\n',
          );
          root = join(f.directory, 'parent', 'child');
        } else if (kind === '.git file') {
          await writeFile(join(f.directory, '.git'), 'gitdir: elsewhere\n');
          root = join(f.directory, 'parent', 'child');
        } else if (kind === '.krn') {
          await mkdir(join(f.directory, kind));
          root = join(f.directory, 'parent', 'child');
        } else if (kind === 'root marker') {
          await mkdir(f.root);
          await writeFile(join(f.root, '.git'), 'gitdir: hidden');
        } else if (kind === 'relative') root = 'relative-slots';
        else if (kind === 'source') root = join(f.source, 'slots');
        else if (kind === 'experiment') root = join(f.experiment, 'slots');
        else if (kind === 'existing') await mkdir(f.slot, { recursive: true });
        else {
          const alias = join(f.directory, 'alias');
          await symlink(f.source, alias);
          root = join(alias, 'slots');
        }
        const result = f.prepare({ root });
        if (kind === 'empty .git directory')
          assert.equal(result.status, 0, result.stderr);
        else failure(result, 65, /root|ancestor|exist|inside/u);
      } finally {
        await f.cleanup();
      }
    });
  }
});
test('eval prepare refuses either direction of root and input overlap', async (t) => {
  for (const kind of [
    'root equals experiment',
    'root is inside experiment',
    'root contains experiment',
    'experiment path equals root experiment directory',
    'root equals source',
    'root is inside source',
    'root contains source',
    'source path equals root experiment directory',
  ]) {
    await t.test(kind, async () => {
      const layout: Parameters<typeof fixture>[0] = {};
      if (kind === 'root contains experiment')
        Object.assign(layout, { experimentName: 'root-parent/experiment' });
      else if (kind === 'experiment path equals root experiment directory')
        Object.assign(layout, {
          id: 'evaluation',
          experimentName: 'root-parent/evaluation',
        });
      else if (kind === 'root contains source')
        Object.assign(layout, { sourceName: 'root-parent/source' });
      else if (kind === 'source path equals root experiment directory')
        Object.assign(layout, { id: 'work', sourceName: 'root-parent/work' });
      const f = await fixture(layout);
      try {
        let root = f.root;
        if (kind === 'root equals experiment') root = f.experiment;
        else if (kind === 'root is inside experiment')
          root = join(f.experiment, 'slots');
        else if (kind === 'root contains experiment')
          root = join(f.directory, 'root-parent');
        else if (kind === 'experiment path equals root experiment directory')
          root = join(f.directory, 'root-parent');
        else if (kind === 'root equals source') root = f.source;
        else if (kind === 'root is inside source')
          root = join(f.source, 'slots');
        else if (kind === 'root contains source')
          root = join(f.directory, 'root-parent');
        else if (kind === 'source path equals root experiment directory')
          root = join(f.directory, 'root-parent');
        failure(
          f.prepare({ root }),
          65,
          /root|source|experiment|overlap|ancestor/u,
        );
      } finally {
        await f.cleanup();
      }
    });
  }
});
