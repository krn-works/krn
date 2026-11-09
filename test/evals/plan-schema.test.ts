import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { digest, failure, fixture, type manifest } from './plan-fixture.ts';

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
