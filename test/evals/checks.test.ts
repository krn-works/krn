import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { requiresIsolation } from '../helpers/isolation.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const digest = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  assert.ok(
    process.env.TMPDIR,
    'runner supplies a private temporary directory',
  );
  const directory = await mkdtemp(join(process.env.TMPDIR, 'eval-check-'));
  const experiment = join(directory, 'experiment');
  const slot = join(directory, 'slot');
  const evaluator = join(directory, "evaluator's tools");
  const repo = join(slot, 'repo');
  const cwd = join(repo, 'package');
  for (const path of [experiment, cwd, evaluator])
    await mkdir(path, { recursive: true });
  const inputs: Record<string, string> = {};
  for (const path of [
    'packet.md',
    'control.md',
    'contract.md',
    'checklist.md',
  ]) {
    await writeFile(join(experiment, path), 'input\r\n');
    inputs[path] = digest('input\r\n');
  }
  const task = {
    id: 'behavior',
    repository: 'fixture',
    baseSha: 'a'.repeat(40),
    exemplarSha: 'b'.repeat(40),
    packet: 'packet.md',
    control: 'control.md',
    contract: 'contract.md',
    checklist: 'checklist.md',
    node: process.version.slice(1),
    workingDirectory: 'package',
    scripts: {
      test: 'node --test behavior.test.cjs',
      nested: 'npm run test',
    } as Record<string, string>,
    focusedCheck: ['npm', 'test'],
    suiteChecks: [{ argv: ['node', '-e', 'process.exit(0)'], tests: false }],
  };
  const value = {
    id: 'checks',
    frozen: true,
    seed: 'fixture',
    replicas: 1,
    arms: [
      { id: 'A', model: 'fixture', harness: 'codex', material: 'none' },
      { id: 'B', model: 'fixture', harness: 'codex', material: 'packet' },
      { id: 'C', model: 'fixture', harness: 'codex', material: 'control' },
      { id: 'R', model: 'fixture', harness: 'claude', material: 'none' },
    ],
    tasks: [task],
    inputs,
  };
  const mise =
    process.env.MISE_DATA_DIR ?? join(homedir(), '.local/share/mise');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MISE_DATA_DIR: mise,
    TMPDIR: evaluator,
  };
  const save = () =>
    writeFile(join(experiment, 'manifest.json'), JSON.stringify(value));
  const args = (extra: string[] = []) => [
    cli,
    'eval',
    'check',
    '--experiment',
    experiment,
    '--slot',
    slot,
    '--task',
    task.id,
    '--check',
    'focused',
    '--json',
    ...extra,
  ];
  const invoke = (argv = args(), environment = env) =>
    spawnSync(process.execPath, argv, {
      encoding: 'utf8',
      env: environment,
      timeout: 20_000,
    });
  const run = (extra: string[] = []) => invoke(args(extra));
  const testFile = (text: string) =>
    writeFile(join(cwd, 'behavior.test.cjs'), text);
  await testFile(
    "require('node:test')('behavior', () => require('node:assert/strict').equal(2 + 2, 4));\n",
  );
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ scripts: { test: 'true' } }),
  );
  await save();
  return {
    directory,
    experiment,
    slot,
    evaluator,
    repo,
    cwd,
    task,
    value,
    env,
    save,
    args,
    invoke,
    run,
    testFile,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function output(result: SpawnSyncReturns<string>) {
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(result.stderr, '');
  return value;
}
function refusal(
  result: SpawnSyncReturns<string>,
  code: number,
  pattern: RegExp,
) {
  assert.equal(result.status, code, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), ['code', 'error', 'ok']);
  assert.equal(value.ok, false);
  assert.equal(value.code, code);
  assert.match(value.error, pattern);
  assert.equal(result.stderr, `${value.error}\n`);
}

test('eval check runs frozen scripts despite candidate edits, sums TAP and fixes its environment', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    const before = await readFile(join(f.experiment, 'manifest.json'));
    const passing = output(f.run());
    assert.equal(passing.status, 'PASS');
    assert.equal(passing.reason, null);
    assert.equal(passing.exitCode, 0);
    assert.deepEqual([passing.tests, passing.pass, passing.fail], [1, 1, 0]);
    f.task.scripts.nested = 'npm run-script test && npm t';
    f.task.focusedCheck = ['npm', 'run', 'nested'];
    await f.save();
    const multiple = output(f.run());
    assert.deepEqual([multiple.tests, multiple.pass, multiple.fail], [2, 2, 0]);
    f.task.scripts.test = 'node -e "process.exit(0)"';
    f.task.focusedCheck = ['npm', 'test'];
    await f.save();
    const empty = output(f.run());
    assert.equal(empty.status, 'FAIL');
    assert.equal(empty.reason, 'no tests executed');
    assert.equal(empty.exitCode, 0);
    assert.deepEqual([empty.tests, empty.pass, empty.fail], [0, 0, 0]);
    await writeFile(join(f.experiment, 'manifest.json'), before);
    assert.deepEqual(await readdir(f.evaluator), []);
    assert.equal(
      await readFile(join(f.cwd, 'package.json'), 'utf8'),
      '{"scripts":{"test":"true"}}',
    );
    assert.deepEqual(
      await readFile(join(f.experiment, 'manifest.json')),
      before,
    );
  } finally {
    await f.cleanup();
  }
});

test('eval check refuses empty selections and failing assertions', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    f.task.scripts.test = 'node --test';
    f.task.focusedCheck = [
      'npm',
      'run',
      'test',
      '--',
      '--test-name-pattern=absent',
      'behavior.test.cjs',
    ];
    await f.save();
    const empty = output(f.run());
    assert.equal(empty.status, 'FAIL');
    assert.equal(empty.reason, 'no tests executed');
    f.task.focusedCheck = ['npm', 't'];
    await f.testFile(
      "require('node:test')('failure', () => require('node:assert/strict').equal(1, 2));\n",
    );
    await f.save();
    const failing = output(f.run());
    assert.equal(failing.status, 'FAIL');
    assert.equal(failing.exitCode, 1);
    assert.equal(failing.fail, 1);
  } finally {
    await f.cleanup();
  }
});

test('eval check blocks unfrozen scripts, installations and npx including nested calls', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    for (const argv of [
      ['npm', 'run', 'missing'],
      ['npm', 'install'],
      ['npx', 'anything'],
      ['npm', 'run', 'nested'],
    ]) {
      f.task.scripts.nested = 'npm install';
      f.task.focusedCheck = argv;
      await f.save();
      const result = output(f.run());
      assert.equal(result.status, 'FAIL');
      assert.equal(result.exitCode, 127);
      assert.equal(result.reason, 'exit 127');
      const message =
        argv[1] === 'run' && argv[2] === 'missing'
          ? 'script not frozen: missing\n'
          : argv[0] === 'npx'
            ? 'npx is disabled for frozen checks\n'
            : 'npm subcommand not allowed: install\n';
      assert.equal(result.stderrSha256, digest(message));
    }
  } finally {
    await f.cleanup();
  }
});

test('eval check isolates network, evaluator tools and other inputs and preserves stream hashes', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  const server = createServer((socket) => socket.destroy());
  try {
    const other = join(f.directory, 'other-slot');
    await mkdir(other);
    await writeFile(join(other, 'canary'), 'untouched');
    const source = join(f.directory, 'source');
    await mkdir(source);
    await writeFile(join(source, 'canary'), 'source unchanged');
    const inputs = new Map<string, Buffer>();
    for (const name of ['manifest.json', ...Object.keys(f.value.inputs)])
      inputs.set(name, await readFile(join(f.experiment, name)));
    await f.testFile(`const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
      test('environment', () => {
        assert.equal(process.cwd(), '/w/repo/package');
        assert.equal(process.env.NODE_OPTIONS, '--test-reporter=tap');
        const paths = process.env.PATH.split(':');
        assert.equal(paths[0], '/w/repo/package/node_modules/.bin');
        assert.equal(paths[2], ${JSON.stringify(dirname(process.execPath))});
        assert.equal(paths[3], '/usr/bin');
        for (const name of ['npm', 'npx', 'scripts.json']) assert.throws(() => fs.writeFileSync(path.join(paths[1], name), 'true'), {code: 'EROFS'});
        for (const file of ${JSON.stringify([join(f.experiment, 'packet.md'), join(other, 'canary'), join(source, 'canary')])}) assert.throws(() => fs.readFileSync(file), {code: 'ENOENT'});
      });`);
    assert.equal(output(f.run()).status, 'PASS');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(address.port, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
    });
    await f.testFile(
      `require('node:test')('network', async () => { await new Promise((resolve, reject) => { const socket = require('node:net').connect(${address.port}, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); resolve(); }); socket.on('error', reject); }); });\n`,
    );
    const network = output(f.run());
    assert.equal(network.status, 'FAIL');
    assert.equal(network.fail, 1);
    assert.equal(await readFile(join(other, 'canary'), 'utf8'), 'untouched');
    assert.equal(
      await readFile(join(source, 'canary'), 'utf8'),
      'source unchanged',
    );
    for (const [name, bytes] of inputs)
      assert.deepEqual(await readFile(join(f.experiment, name)), bytes);
    f.task.suiteChecks[0] = {
      argv: [
        'node',
        '-e',
        'process.stdout.write(Buffer.from([0,255,65,10]));process.stderr.write(Buffer.from([0,254,66,10]));process.exitCode=7',
      ],
      tests: false,
    };
    await f.save();
    const args = f.args();
    args[args.indexOf('focused')] = 'suite:0';
    const bytes = output(f.invoke(args));
    assert.equal(bytes.exitCode, 7);
    assert.equal(bytes.stdoutSha256, digest(Buffer.from([0, 255, 65, 10])));
    assert.equal(bytes.stderrSha256, digest(Buffer.from([0, 254, 66, 10])));
    assert.deepEqual(output(f.invoke(args)), bytes);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});

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

test('eval check accepts non-test checks and explicit drafts', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    f.value.frozen = false;
    await f.save();
    refusal(f.run(), 65, /frozen/u);
    const args = f.args(['--draft']);
    args[args.indexOf('focused')] = 'suite:0';
    const result = output(f.invoke(args));
    assert.equal(result.status, 'PASS');
    assert.deepEqual([result.tests, result.pass, result.fail], [0, 0, 0]);
    const text = f.invoke(args.filter((arg) => arg !== '--json'));
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /PASS/u);
    f.task.suiteChecks[0] = {
      argv: ['node', '-e', 'console.log("# tests 1\\n# pass 0\\n# fail 1")'],
      tests: true,
    };
    await f.save();
    const failed = output(f.invoke(args));
    assert.equal(failed.reason, '1 failed');
  } finally {
    await f.cleanup();
  }
});

test('eval check timeout kills detached descendants and remains a failure after passing TAP', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    const marker = `eval-child-${digest(f.directory).slice(0, 20)}`;
    f.task.focusedCheck = [
      'node',
      '-e',
      `require('node:child_process').spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('child-started', 'ready'); setInterval(()=>{},1000)", '${marker}'], {detached:true,stdio:'ignore'}); console.log('# tests 1\\n# pass 1\\n# fail 0'); setInterval(()=>{},1000);`,
    ];
    await f.save();
    const child = spawn(process.execPath, f.args(['--timeout', '2']), {
      env: f.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => {
      stdout += bytes;
    });
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.reason, 'timeout');
    assert.equal(result.exitCode, 137);
    assert.equal(await readFile(join(f.cwd, 'child-started'), 'utf8'), 'ready');
    const deadline = Date.now() + 5000;
    for (;;) {
      const ps = spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8' });
      assert.equal(ps.status, 0, ps.stderr);
      if (!ps.stdout.includes(marker)) break;
      assert.ok(Date.now() < deadline, 'no descendant may survive the timeout');
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    await f.cleanup();
  }
});

test('eval check reports missing and mismatched Node installations as data errors', async () => {
  const f = await fixture();
  try {
    f.task.node = '0.0.0';
    await f.save();
    refusal(f.run(), 65, /[Nn]ode.*0\.0\.0/u);
    const fake = join(f.directory, 'mise');
    const bin = join(fake, 'installs/node/0.0.0/bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'node'), '#!/bin/sh\nprintf "v1.2.3\\n"\n', {
      mode: 0o755,
    });
    refusal(
      f.invoke(f.args(), { ...f.env, MISE_DATA_DIR: fake }),
      65,
      /version|0\.0\.0/u,
    );
    await chmod(join(bin, 'node'), 0o644);
    refusal(
      f.invoke(f.args(), { ...f.env, MISE_DATA_DIR: fake }),
      65,
      /[Nn]ode/u,
    );
  } finally {
    await f.cleanup();
  }
});

test('eval check validates usage and check selection before running', async () => {
  const f = await fixture();
  try {
    for (const extra of [
      ['--json'],
      ['--draft', '--draft'],
      ['--unknown'],
      ['--timeout', '0'],
      ['--timeout', 'NaN'],
      ['--timeout', '9007199254740992'],
      ['--timeout', '1', '--timeout', '2'],
      ['--slot', f.slot],
    ])
      refusal(f.run(extra), 64, /once|unknown|timeout|usage/u);
    for (const name of ['other', 'suite:-1', 'suite:01', 'suite:999']) {
      const args = f.args();
      args[args.indexOf('focused')] = name;
      refusal(f.invoke(args), 64, /check/u);
    }
    const unknown = f.args();
    unknown[unknown.indexOf('behavior')] = 'unknown';
    refusal(f.invoke(unknown), 65, /task/u);
    for (const option of ['--experiment', '--task', '--slot', '--check']) {
      const args = f.args();
      args.splice(args.indexOf(option), 2);
      refusal(f.invoke(args), 64, /usage/u);
    }
  } finally {
    await f.cleanup();
  }
});

test('eval check rejects unsafe paths and preserves experiment bytes', async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.experiment, 'manifest.json'));
    const alias = join(f.directory, 'alias');
    await symlink(f.slot, alias);
    for (const path of [
      'relative',
      f.experiment,
      f.directory,
      alias,
      `${alias}/../slot`,
      join(f.directory, 'absent'),
      join(f.cwd, 'package.json'),
      '/',
      join(f.directory, 'x'.repeat(5000)),
    ]) {
      const args = f.args();
      args[args.indexOf(f.slot)] = path;
      refusal(f.invoke(args), 65, /slot|path|directory|overlap/u);
    }
    const parent = join(f.repo, 'link');
    await symlink(f.cwd, parent);
    f.task.workingDirectory = 'link';
    await f.save();
    refusal(f.run(), 65, /symlink/u);
    f.task.workingDirectory = 'link/child';
    await f.save();
    refusal(f.run(), 65, /symlink/u);
    for (const directory of ['absent', 'package/behavior.test.cjs']) {
      f.task.workingDirectory = directory;
      await f.save();
      refusal(f.run(), 65, /directory/u);
    }
    await writeFile(join(f.experiment, 'manifest.json'), before);
    const nestedSlot = join(f.experiment, 'slot');
    await mkdir(join(nestedSlot, 'repo'), { recursive: true });
    const nestedArgs = f.args();
    nestedArgs[nestedArgs.indexOf(f.slot)] = nestedSlot;
    refusal(f.invoke(nestedArgs), 65, /overlap/u);
    assert.deepEqual(await readdir(nestedSlot), ['repo']);
    const args = f.args();
    refusal(f.invoke(args, { ...f.env, TMPDIR: f.slot }), 65, /overlap/u);
    refusal(f.invoke(args, { ...f.env, TMPDIR: f.directory }), 65, /overlap/u);
    refusal(f.invoke(args, { ...f.env, TMPDIR: f.experiment }), 65, /overlap/u);
    refusal(
      f.invoke(args, { ...f.env, TMPDIR: join(f.slot, 'scratch') }),
      65,
      /overlap/u,
    );
    refusal(f.invoke(args, { ...f.env, TMPDIR: '/tmp' }), 65, /overlap/u);
    const linkedScratch = join(f.directory, 'scratch-link');
    await symlink(f.evaluator, linkedScratch);
    refusal(
      f.invoke(args, { ...f.env, TMPDIR: linkedScratch }),
      65,
      /symlink/u,
    );
    for (const name of ['home', 't']) {
      await symlink(f.evaluator, join(f.slot, name));
      refusal(f.run(), 65, /symlink/u);
      await rm(join(f.slot, name));
    }
    assert.deepEqual(
      await readFile(join(f.experiment, 'manifest.json')),
      before,
    );
  } finally {
    await f.cleanup();
  }
});

test('eval check validates strict manifest additions and portable working directories', async () => {
  const f = await fixture();
  try {
    const original = JSON.stringify(f.task);
    const cases: Record<string, unknown>[] = [
      { node: 'v24.22.1' },
      { node: '24' },
      { workingDirectory: '' },
      { workingDirectory: '../package' },
      { workingDirectory: '/package' },
      { workingDirectory: './package' },
      { workingDirectory: 'package/' },
      { workingDirectory: 'a//b' },
      { workingDirectory: 'a\\b' },
      { workingDirectory: 'a\0b' },
      { scripts: JSON.parse('{"__proto__":"true"}') },
      { scripts: { constructor: 'true' } },
      { scripts: { '': 'true' } },
      { scripts: { 'a=b': 'true' } },
      { scripts: { 'a/b': 'true' } },
      { scripts: { 'a\0b': 'true' } },
      { scripts: { test: '\0' } },
      { scripts: { test: '' } },
      { scripts: { test: '   ' } },
      { suiteChecks: [] },
      { suiteChecks: [{ argv: ['true'], tests: false, unknown: true }] },
      { suiteChecks: [{ argv: [], tests: true }] },
      { suiteChecks: [{ argv: ['true'] }] },
    ];
    for (const change of cases) {
      Object.assign(f.task, JSON.parse(original), change);
      await f.save();
      refusal(f.run(), 65, /manifest/u);
    }
    Object.assign(f.task, JSON.parse(original), {
      workingDirectory: '.',
      node: '0.0.0',
    });
    await f.save();
    refusal(f.run(), 65, /[Nn]ode.*0\.0\.0/u);
  } finally {
    await f.cleanup();
  }
});

test('eval check rejects Node tool paths through symlinks or candidate areas before executing them', async () => {
  const f = await fixture();
  try {
    const install = join(f.directory, 'mise');
    const bin = join(install, 'installs/node', f.task.node, 'bin');
    await mkdir(bin, { recursive: true });
    const executable = join(bin, 'node');
    await writeFile(
      executable,
      `#!/bin/sh\ntouch "$0.started"\nprintf 'v${f.task.node}\\n'\n`,
      { mode: 0o755 },
    );
    const link = join(f.directory, 'mise-link');
    await symlink(install, link);
    for (const data of [link, `${link}/../mise`])
      refusal(
        f.invoke(f.args(), { ...f.env, MISE_DATA_DIR: data }),
        65,
        /symlink/u,
      );
    for (const area of [f.slot, f.experiment]) {
      const nodeBin = join(area, 'installs/node', f.task.node, 'bin');
      await mkdir(nodeBin, { recursive: true });
      await writeFile(join(nodeBin, 'node'), await readFile(executable), {
        mode: 0o755,
      });
      refusal(
        f.invoke(f.args(), { ...f.env, MISE_DATA_DIR: area }),
        65,
        /overlap/u,
      );
      await assert.rejects(access(join(nodeBin, 'node.started')), {
        code: 'ENOENT',
      });
    }
    await assert.rejects(access(`${executable}.started`), { code: 'ENOENT' });
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

test('eval check maps inaccessible directories to data refusals', async () => {
  const f = await fixture();
  try {
    for (const path of [f.cwd, f.evaluator]) {
      await chmod(path, 0);
      try {
        refusal(f.run(), 65, /EACCES/u);
      } finally {
        await chmod(path, 0o755);
      }
    }
    assert.deepEqual(await readdir(f.evaluator), []);
  } finally {
    await f.cleanup();
  }
});

test('eval check accepts repository cwd and canonicalizes safe absolute slot spellings', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    f.task.workingDirectory = '.';
    f.task.suiteChecks[0] = {
      argv: [
        'node',
        '-e',
        "require('node:assert/strict').equal(process.cwd(), '/w/repo')",
      ],
      tests: false,
    };
    await f.save();
    const args = f.args();
    args[args.indexOf('focused')] = 'suite:0';
    args[args.indexOf(f.slot)] = `${f.slot}//repo/../`;
    args[args.indexOf(f.experiment)] = 'experiment';
    const result = spawnSync(process.execPath, args, {
      cwd: f.directory,
      env: f.env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(output(result).status, 'PASS');
  } finally {
    await f.cleanup();
  }
});
