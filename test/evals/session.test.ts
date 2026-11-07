import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CODEX_CONFIG } from '../../src/evals/session.ts';
import { SessionUsage } from '../../src/evals/usage.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const fake = fileURLToPath(
  new URL('../fixtures/eval/harness.cjs', import.meta.url),
);
const capturedCodex = fileURLToPath(
  new URL('../fixtures/eval/codex-completed.jsonl', import.meta.url),
);
const hash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const jsonl = (events: unknown[]) =>
  `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const turn = (
  input: number,
  output: number,
  cached: number,
  reasoning: number,
) => ({
  type: 'turn.completed',
  usage: {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cached,
    reasoning_output_tokens: reasoning,
  },
});
const codexStream = jsonl([
  { type: 'thread.started', thread_id: 'fixture' },
  { type: 'turn.started' },
  {
    type: 'item.started',
    item: { type: 'command_execution', command: 'true' },
  },
  turn(11, 5, 7, 3),
  { type: 'turn.started' },
  turn(13, 7, 9, 4),
]);
async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    if ((await lstat(path)).isDirectory()) {
      for (const [child, bytes] of Object.entries(await tree(path)))
        files[join(name, child)] = bytes;
    } else files[name] = (await readFile(path)).toString('base64');
  }
  return files;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'krn-eval-session-'));
  const experiment = join(directory, 'experiment');
  const root = join(directory, 'root');
  const slot = join(root, 'fixture-experiment', 'workspace');
  const neighbour = join(root, 'fixture-experiment', 'neighbour');
  const home = join(directory, 'home');
  const tools = join(directory, 'tools');
  for (const path of [
    experiment,
    join(slot, 'repo'),
    neighbour,
    tools,
    join(home, '.codex'),
  ])
    await mkdir(path, { recursive: true });
  await writeFile(join(home, '.codex', 'auth.json'), 'fixture login\n');
  await writeFile(join(home, '.codex', 'private'), 'hidden\n');
  await writeFile(join(neighbour, 'private'), 'neighbour\n');
  const inputs: Record<string, string> = {};
  for (const name of [
    'packet.md',
    'control.md',
    'contract.md',
    'checklist.md',
  ]) {
    await writeFile(join(experiment, name), 'fixture\n');
    inputs[name] = hash('fixture\n');
  }
  const manifest = {
    id: 'fixture-experiment',
    frozen: true,
    seed: 'fixture',
    replicas: 1,
    arms: ['A', 'B', 'C', 'R'].map((id) => ({
      id,
      model: 'fixture-model',
      harness: id === 'R' ? 'claude' : 'codex',
      material: id === 'B' ? 'packet' : id === 'C' ? 'control' : 'none',
    })),
    tasks: [
      {
        id: 'workspace',
        repository: 'fixture',
        baseSha: 'a'.repeat(40),
        exemplarSha: 'b'.repeat(40),
        packet: 'packet.md',
        control: 'control.md',
        contract: 'contract.md',
        checklist: 'checklist.md',
        focusedCheck: ['true'],
        suiteChecks: [['true']],
      },
    ],
    inputs,
  };
  const save = () =>
    writeFile(join(experiment, 'manifest.json'), JSON.stringify(manifest));
  await save();
  const prompt = Buffer.from('\ufeffPrompt 💫\r\n');
  const promptFile = join(directory, 'prompt');
  await writeFile(promptFile, prompt);
  await copyFile(fake, join(tools, 'harness.cjs'));
  const binary = join(tools, 'harness');
  await writeFile(
    binary,
    `#!${process.execPath}\nrequire('./harness.cjs');\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: home,
    KRN_EVAL_CODEX_BIN: binary,
  };
  const invoke = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [cli, 'eval', ...args], {
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      timeout: 30_000,
    });
  const invokeAsync = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (done, fail) => {
        const child = spawn(process.execPath, [cli, 'eval', ...args], { env });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.stdout.setEncoding('utf8').on('data', (c) => (stdout += c));
        child.stderr.setEncoding('utf8').on('data', (c) => (stderr += c));
        child.once('error', fail);
        child.once('close', (status) => {
          clearTimeout(timer);
          done({ status, stdout, stderr });
        });
      },
    );
  const planned = invoke(['plan', '--experiment', experiment, '--json']);
  assert.equal(planned.status, 0, planned.stderr);
  const runs: { arm: string; runId: string }[] = JSON.parse(
    planned.stdout,
  ).runs;
  const runId = (arm = 'A') => {
    const run = runs.find((run) => run.arm === arm);
    assert.ok(run);
    return run.runId;
  };
  const args = (arm = 'A') => [
    'session',
    '--experiment',
    experiment,
    '--root',
    root,
    '--run',
    runId(arm),
    '--slot',
    slot,
    '--prompt-file',
    promptFile,
    '--json',
  ];
  const output = (arm = 'A') => join(root, manifest.id, 'runs', runId(arm));
  const scenario = async (
    stream: string | Buffer = codexStream,
    exitCode = 0,
    timeout = false,
  ) => {
    await writeFile(
      join(slot, 'repo', 'scenario.json'),
      JSON.stringify({
        stream: Buffer.from(stream).toString('base64'),
        stderr: Buffer.from([0, 255, 10]).toString('base64'),
        prompt: prompt.toString('base64'),
        hidden: [experiment, home, neighbour, output(), '/w/home/.codex'],
        model: 'fixture-model',
        exitCode,
        timeout,
      }),
    );
  };
  return {
    directory,
    experiment,
    root,
    slot,
    neighbour,
    home,
    tools,
    binary,
    manifest,
    save,
    prompt,
    promptFile,
    invoke,
    invokeAsync,
    args,
    output,
    scenario,
    runId,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function refusedAsync(
  f: Awaited<ReturnType<typeof fixture>>,
  args: string[],
  code = 65,
) {
  const observed = await f.invokeAsync(args);
  assert.equal(observed.status, code, observed.stderr);
  const envelope = JSON.parse(observed.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, code);
}

function refused(
  f: Awaited<ReturnType<typeof fixture>>,
  args: string[],
  code = 65,
) {
  const observed = f.invoke(args);
  assert.equal(observed.status, code, observed.stderr);
  const envelope = JSON.parse(observed.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, code);
}

async function installFakeBwrap(
  f: Awaited<ReturnType<typeof fixture>>,
  capture: string,
) {
  const script = join(f.tools, 'bwrap.cjs');
  await writeFile(
    script,
    `const fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\nfs.writeSync(3, 'started');\n`,
  );
  await writeFile(
    join(f.tools, 'bwrap'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    { mode: 0o755 },
  );
}

test('eval Codex config disables ambient integrations with recognised settings', () => {
  for (const feature of [
    'apps',
    'plugins',
    'remote_plugin',
    'skill_search',
    'skill_mcp_dependency_install',
    'browser_use',
    'browser_use_external',
    'browser_use_full_cdp_access',
    'computer_use',
    'image_generation',
    'hooks',
    'memories',
  ])
    assert.match(CODEX_CONFIG, new RegExp(`^${feature} = false$`, 'mu'));
  assert.match(CODEX_CONFIG, /^web_search = "disabled"$/mu);
  assert.ok(
    CODEX_CONFIG.indexOf('web_search =') < CODEX_CONFIG.indexOf('[history]'),
  );
  assert.doesNotMatch(
    CODEX_CONFIG,
    /^(skills|multi_agent|goals|tool_suggest) =/mu,
  );
});

const rejectedConfigMessages = [
  '`features.skills` is ignored',
  'The configuration setting `features.skills` is ignored.',
  'Unrecognized configuration key: features.unknown',
  'Unrecognised config setting: features.unknown',
];

test('eval Codex stream remembers rejected configuration after a completed tool turn', () => {
  for (const message of rejectedConfigMessages) {
    const accounting = new SessionUsage();
    accounting.push(
      Buffer.from(jsonl([{ type: 'error', message }]) + codexStream),
    );
    accounting.finish();
    assert.equal(accounting.configRejected, true, message);
    assert.equal(accounting.truncated, false);
  }
  for (const event of [
    { type: 'error', message: 'provider unavailable' },
    { type: 'error', message: 'ignored command output' },
    { type: 'error', message: 'unrecognized model' },
    { type: 'error', message: { config: 'ignored' } },
    { type: 'item.completed', message: rejectedConfigMessages[0] },
  ]) {
    const accounting = new SessionUsage();
    accounting.push(Buffer.from(jsonl([event]) + codexStream));
    accounting.finish();
    assert.equal(accounting.configRejected, false);
  }
});

test('eval session classifies a rejected Codex config as harness_error despite completion', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  for (const message of rejectedConfigMessages) {
    const f = await fixture();
    try {
      await f.scenario(jsonl([{ type: 'error', message }]) + codexStream);
      const observed = f.invoke(f.args());
      assert.equal(observed.status, 0, observed.stderr);
      const record = JSON.parse(
        await readFile(join(f.output(), 'session.json'), 'utf8'),
      );
      assert.equal(record.status, 'harness_error');
      assert.equal(record.reason, 'config_rejected');
      assert.equal(record.exitCode, 0);
    } finally {
      await f.cleanup();
    }
  }
});

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
      .trim()
      .split('\n')
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

test('eval session accounts the captured Codex stream through the harness', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const f = await fixture();
  try {
    const stream = await readFile(capturedCodex);
    await f.scenario(stream);
    const observed = f.invoke(f.args());
    assert.equal(observed.status, 0, observed.stderr);
    const record = JSON.parse(
      await readFile(join(f.output(), 'session.json'), 'utf8'),
    );
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.usage, {
      status: 'complete',
      input_tokens: 20_385,
      output_tokens: 47,
      cached_input_tokens: 12_160,
      reasoning_output_tokens: 0,
      total_tokens: 20_432,
    });
    assert.deepEqual(await readFile(join(f.output(), 'stream.jsonl')), stream);
  } finally {
    await f.cleanup();
  }
});

test('eval usage accounts captured Codex tokens with cached input as a subset', async () => {
  const stream = await readFile(capturedCodex);
  const accounting = new SessionUsage();
  accounting.push(stream);
  accounting.finish();
  assert.deepEqual(accounting.summary(false), {
    status: 'complete',
    input_tokens: 20_385,
    output_tokens: 47,
    cached_input_tokens: 12_160,
    reasoning_output_tokens: 0,
    total_tokens: 20_432,
  });
});

test('eval session distinguishes incomplete streams, invalid usage and infrastructure failures', {
  concurrency: 4,
}, async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const cases = [
    {
      name: 'cut before completion',
      arm: 'A',
      stream: jsonl([{ type: 'turn.started' }]),
      status: 'truncated',
      exit: 0,
    },
    {
      name: 'cut during next turn',
      arm: 'A',
      stream: jsonl([turn(1, 2, 0, 0), { type: 'turn.started' }]),
      status: 'truncated',
      exit: 0,
    },
    { name: 'empty', arm: 'A', stream: '', status: 'truncated', exit: 0 },
    {
      name: 'provider error',
      arm: 'A',
      stream: jsonl([{ type: 'error', message: 'provider unavailable' }]),
      status: 'harness_error',
      exit: 9,
    },
    {
      name: 'error after tool',
      arm: 'A',
      stream: jsonl([
        { type: 'item.started', item: { type: 'command_execution' } },
        { type: 'turn.failed', error: { message: 'failed' } },
      ]),
      status: 'agent_error',
      exit: 7,
    },
    {
      name: 'missing Codex usage',
      arm: 'A',
      stream: jsonl([{ type: 'turn.completed', usage: { input_tokens: 2 } }]),
      status: 'completed',
      exit: 0,
    },
    {
      name: 'invalid UTF-8',
      arm: 'A',
      stream: `${codexStream}\ufffd`,
      status: 'truncated',
      exit: 0,
    },
  ];
  for (const c of cases)
    t.test(c.name, async () => {
      const f = await fixture();
      try {
        await f.scenario(c.stream, c.exit);
        const observed = await f.invokeAsync(f.args(c.arm));
        assert.equal(observed.status, c.exit, observed.stderr);
        const record = JSON.parse(
          await readFile(join(f.output(c.arm), 'session.json'), 'utf8'),
        );
        assert.equal(record.status, c.status);
        assert.equal(record.usage.status, 'missing');
        assert.equal(record.usage.total_tokens, null);
      } finally {
        await f.cleanup();
      }
    });
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
