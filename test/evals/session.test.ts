import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';
import {
  cli,
  codexStream,
  fixture,
  hash,
  installFakeBwrap,
  refused,
  refusedAsync,
  tree,
} from './session-fixture.ts';

test('eval mask with network exposes the host resolved resolv.conf bytes', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    const observed = spawnSync(
      process.execPath,
      [
        cli,
        'eval',
        'mask',
        '--slot',
        f.slot,
        '--network',
        '--',
        '/usr/bin/cat',
        '/etc/resolv.conf',
      ],
      {
        env: { ...process.env, KRN_EVAL_RESOLV_CONF: '/etc/resolv.conf' },
        timeout: 30_000,
      },
    );
    assert.equal(observed.status, 0, observed.stderr.toString());
    assert.deepEqual(
      observed.stdout,
      await readFile(await realpath('/etc/resolv.conf')),
    );
  } finally {
    await f.cleanup();
  }
});

test('eval mask binds only the final resolver file read-only when network is enabled', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    const resolver = join(f.directory, 'resolver');
    await mkdir(resolver);
    const target = join(resolver, 'nameservers');
    const neighbour = join(resolver, 'private');
    const bytes = Buffer.from('nameserver 127.0.0.53\n# fixture\r\n');
    await writeFile(target, bytes);
    await writeFile(neighbour, 'hidden\n');
    const alias = join(f.directory, 'resolv.conf');
    const intermediate = join(f.directory, 'resolver-link');
    await symlink('resolver/nameservers', intermediate);
    await symlink('resolver-link', alias);
    const before = await tree(resolver);
    const env = { KRN_EVAL_RESOLV_CONF: alias };
    const offline = f.invoke(
      ['mask', '--slot', f.slot, '--', '/usr/bin/test', '!', '-e', target],
      env,
    );
    assert.equal(offline.status, 0, offline.stderr);
    const dangling = join(f.directory, 'dangling-resolver');
    await symlink('absent', dangling);
    const withoutResolver = f.invoke(
      ['mask', '--slot', f.slot, '--', '/usr/bin/true'],
      { KRN_EVAL_RESOLV_CONF: dangling },
    );
    assert.equal(withoutResolver.status, 0, withoutResolver.stderr);
    const observed = f.invoke(
      [
        'mask',
        '--slot',
        f.slot,
        '--network',
        '--tool',
        dirname(process.execPath),
        '--',
        process.execPath,
        '-e',
        `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        process.stdout.write(fs.readFileSync(process.argv[1]).toString('base64'));
        assert.throws(() => fs.appendFileSync(process.argv[1], 'forbidden'), { code: 'EROFS' });
        assert.equal(fs.existsSync(process.argv[2]), false);
      `,
        target,
        neighbour,
      ],
      env,
    );
    assert.equal(observed.status, 0, observed.stderr);
    assert.deepEqual(Buffer.from(observed.stdout, 'base64'), bytes);
    assert.deepEqual(await tree(resolver), before);
  } finally {
    await f.cleanup();
  }
});

test('eval mask refuses dangling and non-regular resolver targets with network', async () => {
  const f = await fixture();
  try {
    const dangling = join(f.directory, 'resolv.conf');
    await symlink('absent', dangling);
    const directoryAlias = join(f.directory, 'resolver-directory');
    await symlink(f.tools, directoryAlias);
    const loop = join(f.directory, 'resolver-loop');
    await symlink(loop, loop);
    const unreadable = join(f.directory, 'resolver-unreadable');
    await writeFile(unreadable, 'nameserver 127.0.0.53\n', { mode: 0o000 });
    try {
      for (const path of [
        dangling,
        directoryAlias,
        f.tools,
        loop,
        unreadable,
        `${f.directory}/absent`,
      ]) {
        const observed = f.invoke(
          ['mask', '--slot', f.slot, '--network', '--', '/usr/bin/true'],
          { KRN_EVAL_RESOLV_CONF: path },
        );
        assert.equal(observed.status, 65, `${path}: ${observed.stderr}`);
      }
    } finally {
      await chmod(unreadable, 0o600);
    }
  } finally {
    await f.cleanup();
  }
});

test('eval session resolves a planned arm, preserves raw bytes and accounts Codex subsets', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const f = await fixture();
  try {
    await f.scenario();
    const protectedBefore = [
      await tree(f.experiment),
      await tree(f.home),
      await tree(f.neighbour),
    ];
    const observed = f.invoke(f.args());
    assert.equal(observed.status, 0, observed.stderr);
    const record = JSON.parse(
      await readFile(join(f.output(), 'session.json'), 'utf8'),
    );
    assert.equal(record.status, 'completed');
    assert.equal(record.exitCode, 0);
    assert.equal(record.runId, f.runId());
    assert.equal(record.arm, 'A');
    assert.equal(record.model, 'fixture-model');
    assert.equal(record.harness, 'codex');
    assert.equal(record.promptSha256, hash(f.prompt));
    const config = await readFile(join(f.slot, 'codex', 'config.toml'));
    assert.equal(record.configSha256, hash(config));
    assert.doesNotMatch(config.toString(), /project_doc_max_bytes/u);
    assert.match(config.toString(), /approval_policy = "never"/u);
    assert.equal(
      (await readFile(join(f.slot, 'codex', 'auth.json'))).length,
      0,
    );
    assert.deepEqual(record.usage, {
      status: 'complete',
      input_tokens: 24,
      output_tokens: 12,
      cached_input_tokens: 16,
      reasoning_output_tokens: 7,
      total_tokens: 36,
    });
    const calls = (await readFile(join(f.output(), 'calls.jsonl'), 'utf8'))
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call) => call.index),
      [1, 2],
    );
    assert.equal(calls[0].kind, 'turn.completed');
    assert.equal(calls[0].usage.cached_input_tokens, 7);
    assert.deepEqual(
      await readFile(join(f.output(), 'stream.jsonl')),
      Buffer.from(codexStream),
    );
    assert.deepEqual(
      await readFile(join(f.output(), 'stderr.log')),
      Buffer.from([0, 255, 10]),
    );
    assert.deepEqual(
      [await tree(f.experiment), await tree(f.home), await tree(f.neighbour)],
      protectedBefore,
    );
    refused(f, f.args()); // Neither evidence nor config may be reused.
  } finally {
    await f.cleanup();
  }
});

test('eval session timeout drains the scope including a detached network listener', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const f = await fixture();
  try {
    await f.scenario('', 0, true);
    const observed = f.invoke([...f.args(), '--timeout', '5']);
    assert.equal(observed.status, 124, observed.stderr);
    const record = JSON.parse(
      await readFile(join(f.output(), 'session.json'), 'utf8'),
    );
    assert.equal(record.status, 'timeout');
    assert.equal(record.usage.status, 'missing');
    const { port } = JSON.parse(
      await readFile(join(f.slot, 'repo', 'listener.json'), 'utf8'),
    );
    await new Promise<void>((resolvePromise, reject) => {
      const socket = connect(port, '127.0.0.1');
      socket.setTimeout(2000, () => {
        socket.destroy();
        reject(new Error('listener probe did not settle'));
      });
      socket.on('connect', () => {
        socket.destroy();
        reject(new Error('detached listener survived'));
      });
      socket.on('error', (error) => {
        assert.equal('code' in error && error.code, 'ECONNREFUSED');
        resolvePromise();
      });
    });
  } finally {
    await f.cleanup();
  }
});

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
