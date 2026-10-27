import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { requiresIsolation } from '../helpers/isolation.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const fake = fileURLToPath(
  new URL('../fixtures/eval/harness.cjs', import.meta.url),
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
const claudeUsage = {
  input_tokens: 11,
  output_tokens: 5,
  cache_read_input_tokens: 7,
  cache_creation_input_tokens: 3,
};
const assistant = (usage: unknown = claudeUsage, id = 'message') => ({
  type: 'assistant',
  message: {
    id,
    model: 'fixture-model',
    usage,
    content: [{ type: 'text', text: 'fixture' }],
  },
});
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  usage: { ...claudeUsage, input_tokens: 999 },
  modelUsage: { 'fixture-model': { inputTokens: 999 } },
};

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
    join(home, '.claude'),
  ])
    await mkdir(path, { recursive: true });
  for (const [dir, file] of [
    ['.codex', 'auth.json'],
    ['.claude', '.credentials.json'],
  ]) {
    await writeFile(join(home, dir ?? '', file ?? ''), 'fixture login\n');
    await writeFile(join(home, dir ?? '', 'private'), 'hidden\n');
  }
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
    KRN_EVAL_CLAUDE_BIN: binary,
  };
  const invoke = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [cli, 'eval', ...args], {
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      timeout: 30_000,
    });
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
        hidden: [
          experiment,
          home,
          neighbour,
          output(),
          '/w/home/.codex',
          '/w/home/.claude',
        ],
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
    args,
    output,
    scenario,
    runId,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
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
    assert.match(config.toString(), /project_doc_max_bytes = 0/u);
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

test('eval session counts each Claude message once and keeps result totals separate', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const f = await fixture();
  try {
    const stream = jsonl([assistant(), assistant(), assistant(), result]);
    await f.scenario(stream);
    const observed = f.invoke(f.args('R'));
    assert.equal(observed.status, 0, observed.stderr);
    const record = JSON.parse(
      await readFile(join(f.output('R'), 'session.json'), 'utf8'),
    );
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.usage, {
      status: 'complete',
      ...claudeUsage,
      total_tokens: 26,
      result: { usage: result.usage, modelUsage: result.modelUsage },
    });
    const calls = (await readFile(join(f.output('R'), 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messageId, 'message');
    assert.deepEqual(calls[0].usage, claudeUsage);
    assert.deepEqual(
      await readFile(join(f.output('R'), 'stream.jsonl')),
      Buffer.from(stream),
    );
    assert.equal(
      record.configSha256,
      hash(await readFile(join(f.slot, 'claude', 'settings.json'))),
    );
    assert.equal(
      (await readFile(join(f.slot, 'claude', '.credentials.json'))).length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test('eval session distinguishes incomplete streams, invalid usage and infrastructure failures', async (t) => {
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
      name: 'invalid Claude usage',
      arm: 'R',
      stream: jsonl([
        assistant({ ...claudeUsage, input_tokens: '11' }),
        result,
      ]),
      status: 'completed',
      exit: 0,
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
    {
      name: 'Claude without result',
      arm: 'R',
      stream: jsonl([assistant()]),
      status: 'truncated',
      exit: 0,
    },
  ];
  for (const c of cases)
    await t.test(c.name, async () => {
      const f = await fixture();
      try {
        await f.scenario(c.stream, c.exit);
        const observed = f.invoke(f.args(c.arm));
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
    const replace = (name: string, value: string) => {
      const args = f.args();
      args[args.indexOf(name) + 1] = value;
      return args;
    };
    refused(f, replace('--run', 'unknown'));
    for (const option of ['--root', '--slot', '--prompt-file']) {
      for (const value of [
        'relative',
        join(f.directory, 'absent'),
        `${f.directory}/bad\\path`,
        `${f.directory}/${'x'.repeat(260)}`,
      ])
        refused(f, replace(option, value));
    }
    for (const value of [
      f.experiment,
      f.slot,
      join(f.slot, 'repo'),
      f.directory,
    ])
      refused(f, replace('--root', value));
    for (const value of ['0', '-1', 'NaN', '1.5'])
      refused(f, [...f.args(), '--timeout', value]);
    for (const extra of [
      ['--json'],
      ['--wat'],
      ['--run', f.runId()],
      ['--timeout'],
    ])
      refused(f, [...f.args(), ...extra], 64);
    const alias = join(f.directory, 'alias');
    await symlink(f.directory, alias);
    refused(
      f,
      replace('--slot', join(alias, 'root', f.manifest.id, 'workspace')),
    );
    refused(f, replace('--prompt-file', join(alias, 'prompt')));
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

test('eval mask refuses credential aliases, non-files, unsafe destinations and duplicates', async () => {
  const f = await fixture();
  try {
    const auth = join(f.home, '.codex', 'auth.json');
    const alias = join(f.directory, 'alias');
    await symlink(f.home, alias);
    const fileAlias = join(f.directory, 'auth-alias');
    await symlink(auth, fileAlias);
    const invoke = (credentials: string[]) =>
      f.invoke([
        'mask',
        '--slot',
        f.slot,
        ...credentials.flatMap((value) => ['--credential', value]),
        '--',
        '/usr/bin/true',
      ]);
    for (const value of [
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
    ]) {
      const observed = invoke([value]);
      assert.equal(observed.status, 65, `${value}: ${observed.stderr}`);
    }
    assert.equal(
      invoke([`${auth}=/w/codex/auth.json`, `${auth}=/w/codex/auth.json`])
        .status,
      65,
    );
    await mkdir(join(f.slot, 'codex'));
    await symlink('../repo', join(f.slot, 'codex', 'alias'));
    assert.equal(invoke([`${auth}=/w/codex/alias/auth.json`]).status, 65);
    await chmod(auth, 0o000);
    assert.equal(invoke([`${auth}=/w/codex/auth.json`]).status, 65);
    await chmod(auth, 0o600);
  } finally {
    await f.cleanup();
  }
});
