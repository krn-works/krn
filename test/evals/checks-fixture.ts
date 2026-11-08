import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const cli = fileURLToPath(
  new URL('../../src/cli/main.ts', import.meta.url),
);
export const digest = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

export async function fixture() {
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

export function output(result: SpawnSyncReturns<string>) {
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(result.stderr, '');
  return value;
}
export function refusal(
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
