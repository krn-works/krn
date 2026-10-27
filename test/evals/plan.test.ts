import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const seed = 'woz-brain-packet-preregistered-orbit';
const taskIds = ['LON-130', 'LON-131', 'LON-133', 'LON-20', 'LON-21', 'LON-22'];
const expectedOrders = [
  ['C,A,B,R', 'R,C,A,B'],
  ['R,C,B,A', 'B,C,A,R'],
  ['A,C,R,B', 'R,B,C,A'],
  ['B,A,R,C', 'B,R,C,A'],
  ['C,R,A,B', 'C,B,A,R'],
  ['A,B,C,R', 'A,R,C,B'],
];

function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifest(ids = ['LON-130']) {
  const inputs: Record<string, string> = {};
  return {
    id: 'woz-brain-packet',
    frozen: true,
    seed,
    replicas: 2,
    arms: [
      { id: 'A', model: 'luna', harness: 'codex', material: 'none' },
      { id: 'B', model: 'luna', harness: 'codex', material: 'packet' },
      { id: 'C', model: 'luna', harness: 'codex', material: 'control' },
      { id: 'R', model: 'opus', harness: 'claude', material: 'none' },
    ],
    tasks: ids.map((id) => ({
      id,
      repository: 'fixture-repository',
      baseSha: 'a'.repeat(40),
      exemplarSha: 'b'.repeat(40),
      packet: 'materials/packet.md',
      control: 'materials/control.md',
      contract: 'contract.md',
      checklist: 'checklist.md',
      node: process.version.slice(1),
      workingDirectory: '.',
      scripts: { test: 'node --test' },
      focusedCheck: ['node', '--test', 'test/behavior.test.ts'],
      suiteChecks: [{ argv: ['npm', 'test'], tests: true }],
    })),
    inputs,
  };
}

async function fixture(ids?: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'krn-eval-plan-'));
  const experiment = join(directory, 'experiment');
  await mkdir(join(experiment, 'materials'), { recursive: true });
  // Unknown commands on the base go through the real legacy forwarding path.
  // A private legacy stub keeps that RED independent of a host installation.
  const legacy = join(directory, 'legacy.mjs');
  await writeFile(
    legacy,
    "process.stderr.write('unknown command: ' + process.argv[2] + '\\n'); process.exitCode = 64;\n",
  );
  const value = manifest(ids);
  async function input(path: string, bytes: string | Buffer) {
    await writeFile(join(experiment, path), bytes);
    value.inputs[path] = digest(bytes);
  }
  await input('materials/packet.md', 'Packet 💫\r\n');
  await input('materials/control.md', 'Other! 💫\r\n');
  await input('contract.md', 'Acceptance contract\n');
  await input('checklist.md', 'Audit checklist\n');
  await input('prereg.md', 'Frozen protocol\r\n');
  async function save(bytes = JSON.stringify(value)) {
    await writeFile(join(experiment, 'manifest.json'), bytes);
  }
  function run(options: string[] = ['--json']) {
    return invoke(['plan', '--experiment', experiment, ...options]);
  }
  function invoke(args: string[], cwd = process.cwd()) {
    return spawnSync(process.execPath, [cli, 'eval', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, KRN_LEGACY_ENTRY: legacy, KRN_FORWARDED: '' },
    });
  }
  await save();
  return {
    directory,
    experiment,
    value,
    input,
    save,
    run,
    invoke,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function failure(
  result: SpawnSyncReturns<string>,
  code: number,
  message: RegExp,
) {
  assert.equal(result.status, code, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(envelope).sort(), ['code', 'error', 'ok']);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, code);
  assert.match(envelope.error, message);
  assert.equal(result.stderr, `${envelope.error}\n`);
}

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

test('eval plan requires frozen inputs unless explicitly printing a draft', async () => {
  const f = await fixture();
  try {
    f.value.frozen = false;
    await f.save();
    failure(f.run(), 65, /frozen.*--draft/u);
    const draft = f.run(['--draft', '--json']);
    assert.equal(draft.status, 0, draft.stderr);
    assert.equal(JSON.parse(draft.stdout).draft, true);
    const text = f.run(['--draft']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /draft/u);
    // --draft bypasses only the frozen flag, never data validation.
    await writeFile(join(f.experiment, 'prereg.md'), 'changed');
    failure(f.run(['--draft', '--json']), 65, /sha256/u);
  } finally {
    await f.cleanup();
  }
});

test('eval plan counts Unicode characters without trimming or newline normalization', async () => {
  const f = await fixture();
  try {
    // 8,000 Unicode code points, despite a larger UTF-16 and UTF-8 size.
    await f.input('materials/packet.md', '💫'.repeat(8000));
    await f.input('materials/control.md', 'c'.repeat(8000));
    await f.save();
    const boundary = f.run();
    assert.equal(boundary.status, 0, boundary.stderr);
    await f.input('materials/packet.md', 'p'.repeat(8001));
    await f.input('materials/control.md', 'c'.repeat(8001));
    await f.save();
    failure(f.run(), 65, /2000.*tokens/u);
    await f.input('materials/packet.md', 'p\r\n');
    await f.input('materials/control.md', 'c\n');
    await f.save();
    failure(f.run(), 65, /control.*character.*packet/u);
  } finally {
    await f.cleanup();
  }
});

test('eval plan rejects invalid schema and incomplete protocol coverage', async (t) => {
  const cases: {
    name: string;
    change: (value: ReturnType<typeof manifest>) => void;
    message: RegExp;
  }[] = [
    {
      name: 'duplicate task id',
      change: (v) => {
        const task = v.tasks[0];
        assert.ok(task);
        v.tasks.push({ ...task });
      },
      message: /duplicate task/u,
    },
    {
      name: 'duplicate arm id',
      change: (v) => {
        v.arms.push({
          id: 'A',
          model: 'luna',
          harness: 'codex',
          material: 'none',
        });
      },
      message: /duplicate arm/u,
    },
    {
      name: 'missing arm',
      change: (v) => {
        v.arms.pop();
      },
      message: /four arms|missing arm/u,
    },
    {
      name: 'replicas zero',
      change: (v) => {
        v.replicas = 0;
      },
      message: /replicas/u,
    },
    {
      name: 'unhashed task input',
      change: (v) => {
        delete v.inputs['contract.md'];
      },
      message: /contract\.md.*inputs/u,
    },
    {
      name: 'reserved input key cannot bypass validation',
      change: (v) => {
        v.inputs = { ...v.inputs, ['__proto__']: digest('missing input') };
      },
      message: /reserved input path/u,
    },
    {
      name: 'unknown root key',
      change: (v) => {
        Object.assign(v, { typo: true });
      },
      message: /Unrecognized key/u,
    },
    {
      name: 'unknown arm key',
      change: (v) => {
        Object.assign(v.arms[0] ?? {}, { typo: true });
      },
      message: /Unrecognized key/u,
    },
    {
      name: 'unknown task key',
      change: (v) => {
        Object.assign(v.tasks[0] ?? {}, { typo: true });
      },
      message: /Unrecognized key/u,
    },
    {
      name: 'invalid base SHA',
      change: (v) => {
        const task = v.tasks[0];
        if (task) task.baseSha = 'main';
      },
      message: /baseSha/u,
    },
    {
      name: 'empty check argv',
      change: (v) => {
        const task = v.tasks[0];
        if (task) task.focusedCheck = [];
      },
      message: /focusedCheck/u,
    },
    {
      name: 'wrong arm material',
      change: (v) => {
        const arm = v.arms[1];
        if (arm) arm.material = 'none';
      },
      message: /material/u,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const f = await fixture();
      try {
        scenario.change(f.value);
        await f.save();
        failure(f.run(), 65, scenario.message);
      } finally {
        await f.cleanup();
      }
    });
  }
});

test('eval plan accepts JSON CRLF whitespace, rejects BOM and malformed UTF-8', async () => {
  const f = await fixture();
  try {
    const crlf = JSON.stringify(f.value, null, 2).replaceAll('\n', '\r\n');
    await f.save(crlf);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    await f.save(`\uFEFF${crlf}`);
    failure(f.run(), 65, /manifest\.json.*JSON/u);
    await f.save('{broken');
    failure(f.run(), 65, /manifest\.json.*JSON/u);
    await writeFile(join(f.experiment, 'manifest.json'), Buffer.from([0xff]));
    failure(f.run(), 65, /manifest\.json.*UTF-8/u);
  } finally {
    await f.cleanup();
  }
});

test('eval plan reports usage errors with the task JSON envelope and exit 64', async () => {
  const f = await fixture();
  try {
    for (const args of [
      ['--json'],
      ['other', '--json'],
      ['plan', '--json'],
      ['plan', '--json', '--experiment'],
      ['plan', '--experiment', f.experiment, '--unknown', '--json'],
      ['plan', '--experiment', f.experiment, '--json', '--json'],
      ['plan', '--experiment', f.experiment, '--draft', '--draft', '--json'],
      [
        'plan',
        '--experiment',
        f.experiment,
        '--experiment',
        f.experiment,
        '--json',
      ],
    ])
      failure(f.invoke(args), 64, /usage|unknown|requires|missing|once/u);
    const text = f.invoke(['plan']);
    assert.equal(text.status, 64);
    assert.equal(text.stdout, '');
    assert.match(text.stderr, /--experiment/u);
    await rm(join(f.experiment, 'manifest.json'));
    failure(f.run(), 65, /manifest\.json.*ENOENT/u);
  } finally {
    await f.cleanup();
  }
});
