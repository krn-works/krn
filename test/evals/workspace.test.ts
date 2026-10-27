import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { requiresIsolation } from '../helpers/isolation.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(repo: string, args: string[], input?: string) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: gitEnv,
    ...(input === undefined ? {} : { input }),
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function files(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    if ((await lstat(path)).isDirectory()) {
      for (const [child, bytes] of Object.entries(await files(path)))
        result[join(name, child)] = bytes;
    } else result[name] = (await readFile(path)).toString('base64');
  }
  return result;
}

async function fixture(
  layout: {
    id?: string;
    sourceName?: string;
    experimentName?: string;
    temporaryRoot?: string;
  } = {},
) {
  // The runner's TMPDIR is under .krn; prepare requires an independent root.
  const directory = await mkdtemp(
    join(layout.temporaryRoot ?? '/tmp', 'krn-eval-workspace-'),
  );
  const source = join(directory, layout.sourceName ?? 'source');
  await mkdir(source, { recursive: true });
  git(source, ['init', '--quiet', '--template=', '--initial-branch=main']);
  await writeFile(join(source, 'base.txt'), 'parent\n');
  git(source, ['add', '.']);
  git(source, ['commit', '--quiet', '-m', 'Parent']);
  const parent = git(source, ['rev-parse', 'HEAD']);
  await writeFile(join(source, 'base.txt'), 'base\n');
  await mkdir(join(source, 'nested'));
  await writeFile(join(source, 'nested', 'input.txt'), 'nested base\n');
  git(source, ['add', '.']);
  git(source, ['commit', '--quiet', '-m', 'Base']);
  const base = git(source, ['rev-parse', 'HEAD']);
  await writeFile(join(source, 'future.txt'), 'exemplar\n');
  git(source, ['add', '.']);
  git(source, ['commit', '--quiet', '-m', 'Exemplar']);
  const exemplar = git(source, ['rev-parse', 'HEAD']);
  const dangling = git(source, ['hash-object', '-w', '--stdin'], 'dangling\n');
  git(source, ['tag', 'future', exemplar]);
  git(source, ['remote', 'add', 'upstream', '/unused-fixture-source']);
  const experiment = join(directory, layout.experimentName ?? 'experiment');
  await mkdir(experiment, { recursive: true });
  const inputs: Record<string, string> = {};
  for (const name of [
    'packet.md',
    'control.md',
    'contract.md',
    'checklist.md',
  ]) {
    const bytes = 'Fixture input\n';
    await writeFile(join(experiment, name), bytes);
    inputs[name] = createHash('sha256').update(bytes).digest('hex');
  }
  const value = {
    id: layout.id ?? 'workspace-experiment',
    frozen: true,
    seed: 'workspace',
    replicas: 1,
    arms: [
      { id: 'A', model: 'fixture', harness: 'codex', material: 'none' },
      { id: 'B', model: 'fixture', harness: 'codex', material: 'packet' },
      { id: 'C', model: 'fixture', harness: 'codex', material: 'control' },
      { id: 'R', model: 'fixture', harness: 'claude', material: 'none' },
    ],
    tasks: ['workspace-task', 'neighbour-task'].map((id) => ({
      id,
      repository: 'fixture',
      baseSha: base,
      exemplarSha: exemplar,
      packet: 'packet.md',
      control: 'control.md',
      contract: 'contract.md',
      checklist: 'checklist.md',
      focusedCheck: ['node', '--test'],
      suiteChecks: [['npm', 'test']],
    })),
    inputs,
  };
  const root = join(directory, 'slots');
  const home = join(directory, 'home');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'private'), 'operator config\n');
  const save = () =>
    writeFile(join(experiment, 'manifest.json'), JSON.stringify(value));
  await save();
  const invoke = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [cli, 'eval', ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, ...env },
      timeout: 20_000,
    });
  const prepare = (
    options: {
      experiment?: string;
      root?: string;
      sources?: string[];
      extra?: string[];
    } = {},
  ) =>
    invoke([
      'prepare',
      '--experiment',
      options.experiment ?? experiment,
      '--root',
      options.root ?? root,
      ...(options.sources ?? [`fixture=${source}`]).flatMap((source) => [
        '--source',
        source,
      ]),
      '--json',
      ...(options.extra ?? []),
    ]);
  return {
    directory,
    source,
    experiment,
    root,
    home,
    value,
    base,
    parent,
    exemplar,
    dangling,
    save,
    invoke,
    prepare,
    slot: join(root, value.id, value.tasks[0]?.id ?? ''),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function failure(
  result: SpawnSyncReturns<string>,
  code: number,
  pattern: RegExp,
) {
  assert.equal(result.status, code, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(envelope).sort(), ['code', 'error', 'ok']);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, code);
  assert.match(envelope.error, pattern);
  assert.equal(result.stderr, `${envelope.error}\n`);
}

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

test('eval prepare validates source labels, base objects and the frozen input contract', async (t) => {
  for (const kind of [
    'missing',
    'duplicate',
    'unknown',
    'missing base',
    'draft',
    'hash',
  ]) {
    await t.test(kind, async () => {
      const f = await fixture();
      try {
        if (kind === 'missing')
          failure(f.prepare({ sources: [] }), 64, /source/u);
        else if (kind === 'duplicate')
          failure(
            f.prepare({
              sources: [`fixture=${f.source}`, `fixture=${f.source}`],
            }),
            64,
            /duplicate|once/u,
          );
        else if (kind === 'unknown')
          failure(
            f.prepare({
              sources: [`fixture=${f.source}`, `unknown=${f.source}`],
            }),
            64,
            /unknown/u,
          );
        else if (kind === 'missing base') {
          for (const task of f.value.tasks) task.baseSha = 'a'.repeat(40);
          await f.save();
          failure(f.prepare(), 65, /base/u);
        } else if (kind === 'draft') {
          f.value.frozen = false;
          await f.save();
          failure(f.prepare(), 65, /frozen.*--draft/u);
          const result = f.prepare({ extra: ['--draft'] });
          assert.equal(result.status, 0, result.stderr);
        } else {
          await writeFile(join(f.experiment, 'packet.md'), 'changed');
          failure(f.prepare(), 65, /sha256/u);
        }
      } finally {
        await f.cleanup();
      }
    });
  }
});

test('eval prepare rejects repository labels outside the identifier rule', async () => {
  const f = await fixture();
  try {
    const task = f.value.tasks[0];
    assert.ok(task);
    task.repository = 'team=repo';
    await f.save();
    failure(f.prepare(), 65, /repository|identifier|regex/u);
  } finally {
    await f.cleanup();
  }
});

test('eval prepare splits source paths at the first equals sign', async () => {
  const f = await fixture();
  try {
    const alias = join(f.directory, 'source=mirror');
    await symlink(f.source, alias);
    const result = f.prepare({ sources: [`fixture=${alias}`] });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await f.cleanup();
  }
});

test('eval prepare names the failed invariant when the exemplar is reachable from base', async () => {
  const f = await fixture();
  try {
    for (const task of f.value.tasks) task.exemplarSha = f.base;
    await f.save();
    failure(f.prepare(), 65, /invariant failed: exemplar object is absent/u);
  } finally {
    await f.cleanup();
  }
});

test('eval mask refuses invalid slots and reports bwrap startup failures as 70', async () => {
  const f = await fixture();
  try {
    for (const slot of [
      'relative',
      f.directory,
      join(f.directory, 'missing'),
    ]) {
      const result = f.invoke(['mask', '--slot', slot, '--', '/usr/bin/true']);
      assert.equal(result.status, 65, result.stderr);
      assert.match(result.stderr, /slot|repo/u);
    }
    const slot = join(f.directory, 'valid-slot');
    await mkdir(join(slot, 'repo'), { recursive: true });
    const tools = join(f.directory, 'tools');
    await mkdir(tools);
    await writeFile(
      join(tools, 'bwrap'),
      '#!/bin/sh\nprintf "fixture bwrap startup failure\\n" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const args = ['mask', '--slot', slot, '--', '/usr/bin/true'];
    const failed = f.invoke(args, { PATH: tools });
    assert.equal(failed.status, 70, failed.stderr);
    assert.equal(failed.stderr, 'fixture bwrap startup failure\n');
    const missing = f.invoke(args, { PATH: join(tools, 'absent') });
    assert.equal(missing.status, 70);
    assert.match(missing.stderr, /bwrap.*ENOENT/u);
  } finally {
    await f.cleanup();
  }
});

test('eval mask refuses tool mounts that overlap reserved paths or the slot', async (t) => {
  const f = await fixture();
  try {
    const slot = join(f.directory, 'valid-slot');
    await mkdir(join(slot, 'repo'), { recursive: true });
    const tools = join(f.directory, 'tools');
    await mkdir(tools);
    await writeFile(
      join(tools, 'bwrap'),
      '#!/bin/sh\nprintf "fixture bwrap started\\n" >&2\nexit 70\n',
      { mode: 0o755 },
    );
    const invoke = (tool: string) =>
      f.invoke(
        ['mask', '--slot', slot, '--tool', tool, '--', '/usr/bin/true'],
        { PATH: tools },
      );
    for (const path of ['/', '/tmp', '/w', '/proc/x', '/usr', '/etc']) {
      await t.test(path, async () => {
        const result = invoke(path);
        assert.equal(result.status, 65, result.stderr);
        assert.match(
          result.stderr,
          /reserved|overlap|protected path|filesystem root/u,
        );
      });
    }
    for (const path of ['/usr/bin', dirname(process.execPath)]) {
      await t.test(`${path} remains available`, async () => {
        const result = invoke(path);
        assert.equal(result.status, 70, result.stderr);
        assert.equal(result.stderr, 'fixture bwrap started\n');
      });
    }
  } finally {
    await f.cleanup();
  }
});

test('eval mask refuses an ancestor of the slot as a tool directory', async () => {
  const temporaryRoot = process.env.TMPDIR;
  assert.ok(temporaryRoot, 'test suite provides a private TMPDIR');
  const f = await fixture({ temporaryRoot });
  try {
    const slot = join(f.directory, 'valid-slot');
    await mkdir(join(slot, 'repo'), { recursive: true });
    const tools = join(f.directory, 'tools');
    await mkdir(tools);
    await writeFile(
      join(tools, 'bwrap'),
      '#!/bin/sh\nprintf "fixture bwrap started\\n" >&2\nexit 70\n',
      { mode: 0o755 },
    );
    const result = f.invoke(
      ['mask', '--slot', slot, '--tool', f.directory, '--', '/usr/bin/true'],
      { PATH: tools },
    );
    assert.equal(result.status, 65, result.stderr);
    assert.match(result.stderr, /overlap.*slot/u);
    const alias = join(f.directory, 'tools-alias');
    await symlink(tools, alias);
    const symlinked = f.invoke(
      ['mask', '--slot', slot, '--tool', alias, '--', '/usr/bin/true'],
      { PATH: tools },
    );
    assert.equal(symlinked.status, 65, symlinked.stderr);
    assert.match(symlinked.stderr, /symlink/u);
  } finally {
    await f.cleanup();
  }
});

test('eval mask provides a private writable /tmp', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    await mkdir(join(f.slot, 'repo'), { recursive: true });
    const hostTmpCanary = join(f.directory, 'host-tmp-canary');
    await writeFile(hostTmpCanary, 'host tmp\n');
    const script = `
      const assert = require('node:assert/strict'), fs = require('node:fs');
      assert.equal(fs.statSync('/tmp').isDirectory(), true);
      fs.writeFileSync('/tmp/private-canary', 'private tmp\\n');
      assert.equal(fs.readFileSync('/tmp/private-canary', 'utf8'), 'private tmp\\n');
      assert.throws(() => fs.readFileSync(${JSON.stringify(hostTmpCanary)}), {code:'ENOENT'});
    `;
    const result = f.invoke([
      'mask',
      '--slot',
      f.slot,
      '--tool',
      '/usr/bin',
      '--tool',
      dirname(process.execPath),
      '--',
      'node',
      '-e',
      script,
    ]);
    assert.equal(result.status, 0, result.stderr.toString());
  } finally {
    await f.cleanup();
  }
});

test('eval mask hides every other workspace and home, fixes paths and preserves raw streams and exit', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    const prepared = f.prepare();
    assert.equal(prepared.status, 0, prepared.stderr);
    const neighbour = join(
      f.root,
      f.value.id,
      'neighbour-task',
      'repo',
      'base.txt',
    );
    const hidden = [
      join(f.experiment, 'packet.md'),
      neighbour,
      join(f.source, 'base.txt'),
      join(f.home, '.codex', 'private'),
      '/w/home/.codex/private',
      '/w/.git',
      '/w/.krn',
      '/.git',
      '/.krn',
    ];
    const script = `
      const assert = require('node:assert/strict'), fs = require('node:fs'), cp = require('node:child_process');
      for (const path of ${JSON.stringify(hidden)}) assert.throws(() => fs.readFileSync(path), {code:'ENOENT'}, path);
      assert.equal(process.cwd(), '/w/repo');
      assert.equal(process.env.HOME, '/w/home');
      assert.equal(process.env.TMPDIR, '/w/t');
      assert.equal(process.env.PATH, ${JSON.stringify(`${dirname(process.execPath)}:/usr/bin`)});
      assert.equal(process.env.KRN_MASK_PRIVATE, undefined);
      assert.equal(fs.readFileSync('base.txt', 'utf8'), 'base\\n');
      fs.writeFileSync('written', 'writable\\n');
      assert.equal(cp.execFileSync('git', ['-C','/w/repo','rev-parse','--show-toplevel'], {encoding:'utf8'}), '/w/repo\\n');
      assert.throws(() => fs.writeFileSync(${JSON.stringify(join(dirname(process.execPath), 'mask-write'))}, ''), {code:'EROFS'});
      process.stdout.write(Buffer.from([0,255,65,10]));
      process.stderr.write(Buffer.from([0,254,66,10]));
      process.exitCode=7;
    `;
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'eval',
        'mask',
        '--slot',
        f.slot,
        '--tool',
        dirname(process.execPath),
        '--',
        'node',
        '-e',
        script,
        '--',
        '--json',
      ],
      {
        env: { ...process.env, HOME: f.home, KRN_MASK_PRIVATE: 'hidden' },
        timeout: 20_000,
      },
    );
    assert.equal(result.status, 7, result.stderr.toString());
    assert.deepEqual(result.stdout, Buffer.from([0, 255, 65, 10]));
    assert.deepEqual(result.stderr, Buffer.from([0, 254, 66, 10]));
    assert.equal(
      await readFile(join(f.slot, 'repo', 'written'), 'utf8'),
      'writable\n',
    );
    const exited = f.invoke([
      'mask',
      '--slot',
      f.slot,
      '--',
      '/usr/bin/sh',
      '-c',
      'printf "bwrap: command stderr\\n" >&2; exit 1',
    ]);
    assert.equal(exited.status, 1, exited.stderr);
    assert.equal(exited.stdout, '');
    assert.equal(exited.stderr, 'bwrap: command stderr\n');
  } finally {
    await f.cleanup();
  }
});

test('eval mask binds short Unix sockets and blocks TCP unless network is requested', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  const server = createServer((socket) => socket.end());
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const prepared = f.prepare();
    assert.equal(prepared.status, 0, prepared.stderr);
    for (const network of [false, true]) {
      const script = `
        const assert = require('node:assert/strict'), fs = require('node:fs'), net = require('node:net');
        const dir = fs.mkdtempSync(process.env.TMPDIR+'/api-filter-test-');
        const unix = net.createServer();
        unix.on('error', error => { throw error; });
        unix.listen(dir+'/api.sock', () => unix.close(() => {
          const socket=net.connect({host:'127.0.0.1',port:${address.port}});
          socket.setTimeout(2000, () => { throw new Error('TCP did not settle'); });
          socket.once('connect', () => { socket.destroy(); assert.equal(${network},true); console.log('connected'); });
          socket.once('error', error => { assert.equal(${network},false); assert.ok(error.code); console.log('blocked'); });
        }));
      `;
      const result = f.invoke([
        'mask',
        '--slot',
        f.slot,
        '--tool',
        dirname(process.execPath),
        ...(network ? ['--network'] : []),
        '--',
        'node',
        '-e',
        script,
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, network ? 'connected\n' : 'blocked\n');
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});
