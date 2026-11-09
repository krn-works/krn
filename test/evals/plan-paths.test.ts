import assert from 'node:assert/strict';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  digest,
  expectedOrders,
  failure,
  fixture,
  taskIds,
} from './plan-fixture.ts';

test('eval plan validates inputs and prints the preregistered order with stable run ids', async () => {
  const f = await fixture(taskIds);
  try {
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, '');
    const plan = JSON.parse(first.stdout);
    assert.equal(plan.ok, true);
    assert.equal(plan.experiment, f.value.id);
    assert.equal(plan.draft, false);
    assert.equal(plan.runs.length, 48);
    const runIds = new Set<string>();
    for (const [taskIndex, task] of taskIds.entries()) {
      for (const replica of [1, 2]) {
        const runs = plan.runs.slice(
          taskIndex * 8 + (replica - 1) * 4,
          taskIndex * 8 + replica * 4,
        );
        assert.equal(
          runs.map((run: { arm: string }) => run.arm).join(','),
          expectedOrders[taskIndex]?.[replica - 1],
        );
        for (const run of runs) {
          assert.equal(run.task, task);
          assert.equal(run.replica, replica);
          assert.equal(
            run.runId,
            digest([f.value.id, task, String(replica), run.arm].join('\0')),
          );
          runIds.add(run.runId);
        }
      }
    }
    assert.equal(runIds.size, 48);
    const second = f.run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    f.value.arms.reverse();
    await f.save();
    assert.equal(f.run().stdout, first.stdout);
    const text = f.run([]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /woz-brain-packet.*frozen/u);
    assert.ok(text.stdout.includes(`LON-130\t1\tC\t${plan.runs[0].runId}`));
  } finally {
    await f.cleanup();
  }
});

test('eval plan refuses changed or missing hashed input bytes', async (t) => {
  for (const missing of [false, true]) {
    await t.test(missing ? 'missing input' : 'hash mismatch', async () => {
      const f = await fixture();
      try {
        const path = join(f.experiment, 'prereg.md');
        if (missing) await rm(path);
        else await writeFile(path, 'Changed protocol\n');
        failure(
          f.run(),
          65,
          missing ? /prereg\.md.*ENOENT/u : /prereg\.md.*sha256/u,
        );
      } finally {
        await f.cleanup();
      }
    });
  }
});

test('eval plan rejects paths outside the experiment and symlinks', async (t) => {
  for (const kind of [
    'parent',
    'absolute',
    'file symlink',
    'directory symlink',
    'manifest symlink',
  ]) {
    await t.test(kind, async () => {
      const f = await fixture();
      try {
        const outside = join(f.directory, 'outside.md');
        await writeFile(outside, 'outside');
        if (kind === 'parent')
          f.value.inputs['../outside.md'] = digest('outside');
        if (kind === 'absolute') f.value.inputs[outside] = digest('outside');
        if (kind === 'file symlink') {
          await symlink(outside, join(f.experiment, 'linked.md'));
          f.value.inputs['linked.md'] = digest('outside');
        }
        if (kind === 'directory symlink') {
          await symlink(f.directory, join(f.experiment, 'linked'));
          f.value.inputs['linked/outside.md'] = digest('outside');
        }
        await f.save();
        if (kind === 'manifest symlink') {
          await writeFile(outside, JSON.stringify(f.value));
          await rm(join(f.experiment, 'manifest.json'));
          await symlink(outside, join(f.experiment, 'manifest.json'));
        }
        failure(f.run(), 65, /relative|symlink|inside/u);
      } finally {
        await f.cleanup();
      }
    });
  }
});

test('eval plan checks every experiment path component through the CLI', async (t) => {
  await t.test(
    'refuses a symlinked experiment path in text output',
    async () => {
      const f = await fixture();
      try {
        const link = join(f.directory, 'experiment-link');
        await symlink(f.experiment, link);
        const result = f.invoke(['plan', '--experiment', link]);
        assert.equal(result.status, 65, result.stderr);
        assert.equal(result.stdout, '');
        assert.match(
          result.stderr,
          /experiment-link.*symlinks are not allowed/u,
        );
      } finally {
        await f.cleanup();
      }
    },
  );

  await t.test(
    'refuses a symlinked experiment path in the JSON envelope',
    async () => {
      const f = await fixture();
      try {
        const link = join(f.directory, 'experiment-link');
        await symlink(f.experiment, link);
        failure(
          f.invoke(['plan', '--experiment', link, '--json']),
          65,
          /experiment-link.*symlinks are not allowed/u,
        );
      } finally {
        await f.cleanup();
      }
    },
  );

  await t.test(
    'accepts a noncanonical path with a parent component',
    async () => {
      const f = await fixture();
      try {
        const path = join(f.experiment, '..', 'experiment');
        const result = f.invoke(['plan', '--experiment', path, '--json']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).experiment, f.value.id);
      } finally {
        await f.cleanup();
      }
    },
  );

  await t.test(
    'refuses a symlinked intermediate experiment directory',
    async () => {
      const f = await fixture();
      try {
        await symlink(f.directory, join(f.directory, 'linkdir'));
        failure(
          f.invoke([
            'plan',
            '--experiment',
            join(f.directory, 'linkdir', 'experiment'),
            '--json',
          ]),
          65,
          /linkdir.*symlinks are not allowed/u,
        );
      } finally {
        await f.cleanup();
      }
    },
  );

  await t.test(
    'refuses an experiment path whose final component is not a directory',
    async () => {
      const f = await fixture();
      try {
        const file = join(f.directory, 'experiment-file');
        await writeFile(file, 'not a directory');
        failure(
          f.invoke(['plan', '--experiment', file, '--json']),
          65,
          /experiment-file.*expected a directory/u,
        );
      } finally {
        await f.cleanup();
      }
    },
  );

  await t.test(
    'accepts a relative experiment path from the CLI working directory',
    async () => {
      const f = await fixture();
      try {
        const result = f.invoke(
          ['plan', '--experiment', 'experiment', '--json'],
          f.directory,
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).experiment, f.value.id);
      } finally {
        await f.cleanup();
      }
    },
  );
});
