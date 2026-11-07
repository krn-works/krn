import assert from 'node:assert/strict';
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  fixture,
  installFakeBwrap,
  refused,
  refusedAsync,
} from './session-fixture.ts';

test('eval session refuses unknown runs and harnesses, invalid paths and CLI options before writing', async () => {
  const f = await fixture();
  try {
    const jobs: Promise<void>[] = [];
    const refuse = (args: string[], code = 65) => {
      jobs.push(refusedAsync(f, args, code));
    };
    const replace = (name: string, value: string) => {
      const args = f.args();
      args[args.indexOf(name) + 1] = value;
      return args;
    };
    refuse(replace('--run', 'unknown'));
    for (const option of ['--root', '--slot', '--prompt-file']) {
      for (const value of [
        'relative',
        join(f.directory, 'absent'),
        `${f.directory}/bad\\path`,
        `${f.directory}/${'x'.repeat(260)}`,
      ])
        refuse(replace(option, value));
    }
    for (const value of [
      f.experiment,
      f.slot,
      join(f.slot, 'repo'),
      f.directory,
    ])
      refuse(replace('--root', value));
    for (const value of ['0', '-1', 'NaN', '1.5'])
      refuse([...f.args(), '--timeout', value]);
    for (const extra of [
      ['--json'],
      ['--wat'],
      ['--run', f.runId()],
      ['--timeout'],
    ])
      refuse([...f.args(), ...extra], 64);
    const alias = join(f.directory, 'alias');
    await symlink(f.directory, alias);
    refuse(replace('--slot', join(alias, 'root', f.manifest.id, 'workspace')));
    refuse(replace('--prompt-file', join(alias, 'prompt')));
    await Promise.all(jobs);
    const arm = f.manifest.arms.find((arm) => arm.id === 'A');
    assert.ok(arm);
    arm.harness = 'unknown';
    await f.save();
    refused(f, f.args());
    assert.deepEqual(await readdir(f.slot), ['repo']);
    assert.deepEqual(await readdir(join(f.root, f.manifest.id)), [
      'neighbour',
      'workspace',
    ]);
  } finally {
    await f.cleanup();
  }
});
test('eval session refuses Claude arms with the supported-harness error', async () => {
  const f = await fixture();
  try {
    const observed = f.invoke(f.args('R'));
    assert.equal(observed.status, 65, observed.stderr);
    const envelope = JSON.parse(observed.stdout);
    assert.deepEqual(Object.keys(envelope).sort(), ['code', 'error', 'ok']);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 65);
    assert.equal(envelope.error, 'only codex sessions are supported');
    assert.equal(observed.stderr, 'only codex sessions are supported\n');
    assert.deepEqual(await readdir(f.slot), ['repo']);
  } finally {
    await f.cleanup();
  }
});
test('eval session refuses a Codex executable directory in home/bin', async () => {
  const f = await fixture();
  try {
    const bin = join(f.home, 'bin');
    await mkdir(bin);
    const executable = join(bin, 'codex');
    await copyFile(f.binary, executable);
    await chmod(executable, 0o755);
    const observed = f.invoke(f.args(), { KRN_EVAL_CODEX_BIN: executable });
    assert.equal(observed.status, 65, observed.stderr);
    const envelope = JSON.parse(observed.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 65);
    assert.ok(envelope.error.includes(bin));
    assert.deepEqual(await readdir(f.slot), ['repo']);
  } finally {
    await f.cleanup();
  }
});
test('eval mask refuses tool directories in home outside mise installs', async () => {
  const f = await fixture();
  try {
    const bin = join(f.home, 'bin');
    await mkdir(bin);
    const capture = join(f.directory, 'bwrap-args.json');
    await installFakeBwrap(f, capture);
    const observed = f.invoke(
      ['mask', '--slot', f.slot, '--tool', bin, '--', '/usr/bin/true'],
      { PATH: f.tools },
    );
    assert.equal(observed.status, 65, observed.stderr);
    assert.match(observed.stderr, /tool directory under HOME/u);
    assert.ok(observed.stderr.includes(bin));
    await assert.rejects(readFile(capture), { code: 'ENOENT' });
  } finally {
    await f.cleanup();
  }
});
test('eval mask allows a versioned mise tool directory inside home', async () => {
  const f = await fixture();
  try {
    const mise = join(f.home, '.local', 'share', 'mise');
    const tool = join(mise, 'installs', 'node', '1.2.3', 'bin');
    await mkdir(tool, { recursive: true });
    const capture = join(f.directory, 'bwrap-args.json');
    await installFakeBwrap(f, capture);
    const observed = f.invoke(
      ['mask', '--slot', f.slot, '--tool', tool, '--', '/usr/bin/true'],
      { MISE_DATA_DIR: mise, PATH: f.tools },
    );
    assert.equal(observed.status, 0, observed.stderr);
    const args = JSON.parse(await readFile(capture, 'utf8')) as string[];
    const mount = args.findIndex(
      (value, index) => value === '--ro-bind' && args[index + 1] === tool,
    );
    assert.notEqual(mount, -1);
    assert.deepEqual(args.slice(mount + 1, mount + 3), [tool, tool]);
  } finally {
    await f.cleanup();
  }
});
test('eval mask refuses credential aliases, non-files, unsafe destinations and duplicates', async () => {
  const f = await fixture();
  try {
    const auth = join(f.home, '.codex', 'auth.json');
    const alias = join(f.directory, 'alias');
    await symlink(f.home, alias);
    const fileAlias = join(f.directory, 'auth-alias');
    await symlink(auth, fileAlias);
    const invoke = (credentials: string[]) =>
      f.invokeAsync([
        'mask',
        '--slot',
        f.slot,
        ...credentials.flatMap((value) => ['--credential', value]),
        '--',
        '/usr/bin/true',
      ]);
    for (const job of [
      `${fileAlias}=/w/codex/auth.json`,
      `${alias}/.codex/auth.json=/w/codex/auth.json`,
      `${f.home}=/w/codex/auth.json`,
      `${f.directory}/absent=/w/codex/auth.json`,
      `${auth}=/w/repo/auth.json`,
      `${auth}=/outside/auth.json`,
      `${auth}=/w/../auth.json`,
      `${auth}=/w/codex/../repo/auth.json`,
      `${auth}=/w/codex//auth.json`,
      `${auth}=/w/codex/auth.json/`,
      `${auth}=relative`,
      `${auth}=/w`,
      `${auth}=/w/codex\\auth.json`,
    ].map((value) => ({ value, observed: invoke([value]) }))) {
      const observed = await job.observed;
      assert.equal(observed.status, 65, `${job.value}: ${observed.stderr}`);
    }
    assert.equal(
      (
        await invoke([
          `${auth}=/w/codex/auth.json`,
          `${auth}=/w/codex/auth.json`,
        ])
      ).status,
      65,
    );
    await mkdir(join(f.slot, 'codex'));
    await symlink('../repo', join(f.slot, 'codex', 'alias'));
    assert.equal(
      (await invoke([`${auth}=/w/codex/alias/auth.json`])).status,
      65,
    );
    await chmod(auth, 0o000);
    assert.equal((await invoke([`${auth}=/w/codex/auth.json`])).status, 65);
    await chmod(auth, 0o600);
  } finally {
    await f.cleanup();
  }
});
