import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';
import { fixture, output, refusal } from './checks-fixture.ts';

test('eval check appends shell-safe arguments and uses local executables', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    await mkdir(join(f.cwd, 'node_modules/.bin'), { recursive: true });
    await writeFile(
      join(f.cwd, 'node_modules/.bin/local-test'),
      `#!/bin/sh\nexec node --test "$@"\n`,
      { mode: 0o755 },
    );
    const filename = "argument ' $(touch escaped);.test.cjs";
    await writeFile(
      join(f.cwd, filename),
      "require('node:test')('local',()=>{});\n",
    );
    f.task.scripts['test:local'] = 'local-test';
    f.task.focusedCheck = ['npm', 'run-script', 'test:local', '--', filename];
    await f.save();
    assert.equal(output(f.run()).status, 'PASS');
    assert.equal((await readdir(f.cwd)).includes('escaped'), false);
    await writeFile(
      join(f.cwd, 'node_modules/.bin/npm'),
      '#!/bin/sh\nexit 0\n',
      { mode: 0o755 },
    );
    f.task.scripts.nested = 'npm run missing';
    f.task.focusedCheck = ['npm', 'run', 'nested'];
    await f.save();
    assert.equal(output(f.run()).exitCode, 127);
  } finally {
    await f.cleanup();
  }
});

test('eval check preserves genuine command error codes and reports mask setup failures as internal errors', async (t) => {
  const f = await fixture();
  try {
    const tools = join(f.directory, 'broken-tools');
    await mkdir(tools);
    await writeFile(
      join(tools, 'bwrap'),
      '#!/bin/sh\nprintf "fixture mask setup failure\\n" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    refusal(
      f.invoke(f.args(), { ...f.env, PATH: tools }),
      70,
      /fixture mask setup failure/u,
    );
    assert.deepEqual(await readdir(f.evaluator), []);
    if (!requiresIsolation(t, t.name, ['bwrap'])) return;
    f.task.suiteChecks[0] = {
      argv: ['node', '-e', 'process.exit(70)'],
      tests: false,
    };
    await f.save();
    const args = f.args();
    args[args.indexOf('focused')] = 'suite:0';
    const result = output(f.invoke(args));
    assert.equal(result.exitCode, 70);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.reason, 'exit 70');
  } finally {
    await f.cleanup();
  }
});
