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
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const cli = fileURLToPath(
  new URL('../../src/cli/main.ts', import.meta.url),
);
export const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
export function git(repo: string, args: string[], input?: string) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: gitEnv,
    ...(input === undefined ? {} : { input }),
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
export async function files(root: string): Promise<Record<string, string>> {
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
export async function fixture(
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
      node: process.version.slice(1),
      workingDirectory: '.',
      scripts: { test: 'node --test' },
      focusedCheck: ['node', '--test'],
      suiteChecks: [{ argv: ['npm', 'test'], tests: true }],
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
export function failure(
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
