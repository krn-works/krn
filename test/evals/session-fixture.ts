// Shared fixture of the eval session tests; split across files so no single
// test file bounds the CI shard wall time.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const cli = fileURLToPath(
  new URL('../../src/cli/main.ts', import.meta.url),
);
export const fake = fileURLToPath(
  new URL('../fixtures/eval/harness.cjs', import.meta.url),
);
export const capturedCodex = fileURLToPath(
  new URL('../fixtures/eval/codex-completed.jsonl', import.meta.url),
);
export const hash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
export const jsonl = (events: unknown[]) =>
  `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
export const turn = (
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
// One turn per session, as codex exec emits it (captures in codexCaptures).
export const codexStream = jsonl([
  { type: 'thread.started', thread_id: 'fixture' },
  { type: 'turn.started' },
  {
    type: 'item.started',
    item: { type: 'command_execution', command: 'true' },
  },
  turn(11, 5, 7, 3),
]);
export async function tree(root: string): Promise<Record<string, string>> {
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

export async function fixture() {
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
    // The fake replays the captured `codex --version` line.
    KRN_FIXTURE_CODEX_VERSION: (
      await readFile(join(codexCaptures, 'version.stdout.txt'), 'utf8')
    ).trim(),
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

export async function refusedAsync(
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

export function refused(
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

export async function installFakeBwrap(
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

// Verbatim codex-cli 0.167.0 receiver captures; provenance.json records each
// command, exit code and sha256.
export const codexCaptures = fileURLToPath(
  new URL('../fixtures/eval/codex-0.167.0/', import.meta.url),
);
type CaptureFile = { file: string; sha256: string };
export type CodexCapture = {
  name: string;
  exitCode: number;
  stdout: CaptureFile;
  stderr: CaptureFile;
};
export async function codexProvenance(): Promise<{
  receiver: string;
  captures: CodexCapture[];
}> {
  return JSON.parse(
    await readFile(join(codexCaptures, 'provenance.json'), 'utf8'),
  );
}
export async function codexCapture(name: string) {
  const capture = (await codexProvenance()).captures.find(
    (entry) => entry.name === name,
  );
  assert.ok(capture, `unknown capture: ${name}`);
  return {
    exitCode: capture.exitCode,
    stdout: await readFile(join(codexCaptures, capture.stdout.file)),
  };
}
