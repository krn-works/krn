// Shared fixture of the `krn eval plan` tests, split across files to keep each
// under the CI per-file bound.
import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const seed = 'woz-brain-packet-preregistered-orbit';
export const taskIds = [
  'LON-130',
  'LON-131',
  'LON-133',
  'LON-20',
  'LON-21',
  'LON-22',
];
export const expectedOrders = [
  ['C,A,B,R', 'R,C,A,B'],
  ['R,C,B,A', 'B,C,A,R'],
  ['A,C,R,B', 'R,B,C,A'],
  ['B,A,R,C', 'B,R,C,A'],
  ['C,R,A,B', 'C,B,A,R'],
  ['A,B,C,R', 'A,R,C,B'],
];

export function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function manifest(ids = ['LON-130']) {
  const inputs: Record<string, string> = {};
  return {
    id: 'woz-brain-packet',
    frozen: true,
    seed,
    replicas: 2,
    arms: [
      { id: 'A', model: 'luna', harness: 'codex', material: 'none' },
      { id: 'B', model: 'luna', harness: 'codex', material: 'packet' },
      { id: 'C', model: 'luna', harness: 'codex', material: 'control' },
      { id: 'R', model: 'opus', harness: 'claude', material: 'none' },
    ],
    tasks: ids.map((id) => ({
      id,
      repository: 'fixture-repository',
      baseSha: 'a'.repeat(40),
      exemplarSha: 'b'.repeat(40),
      packet: 'materials/packet.md',
      control: 'materials/control.md',
      contract: 'contract.md',
      checklist: 'checklist.md',
      node: process.version.slice(1),
      workingDirectory: '.',
      scripts: { test: 'node --test' },
      focusedCheck: ['node', '--test', 'test/behavior.test.ts'],
      suiteChecks: [{ argv: ['npm', 'test'], tests: true }],
    })),
    inputs,
  };
}

export async function fixture(ids?: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'krn-eval-plan-'));
  const experiment = join(directory, 'experiment');
  await mkdir(join(experiment, 'materials'), { recursive: true });
  // Unknown commands on the base go through the real legacy forwarding path.
  // A private legacy stub keeps that RED independent of a host installation.
  const legacy = join(directory, 'legacy.mjs');
  await writeFile(
    legacy,
    "process.stderr.write('unknown command: ' + process.argv[2] + '\\n'); process.exitCode = 64;\n",
  );
  const value = manifest(ids);
  async function input(path: string, bytes: string | Buffer) {
    await writeFile(join(experiment, path), bytes);
    value.inputs[path] = digest(bytes);
  }
  await input('materials/packet.md', 'Packet 💫\r\n');
  await input('materials/control.md', 'Other! 💫\r\n');
  await input('contract.md', 'Acceptance contract\n');
  await input('checklist.md', 'Audit checklist\n');
  await input('prereg.md', 'Frozen protocol\r\n');
  async function save(bytes = JSON.stringify(value)) {
    await writeFile(join(experiment, 'manifest.json'), bytes);
  }
  function run(options: string[] = ['--json']) {
    return invoke(['plan', '--experiment', experiment, ...options]);
  }
  function invoke(args: string[], cwd = process.cwd()) {
    return spawnSync(process.execPath, [cli, 'eval', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, KRN_LEGACY_ENTRY: legacy, KRN_FORWARDED: '' },
    });
  }
  await save();
  return {
    directory,
    experiment,
    value,
    input,
    save,
    run,
    invoke,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export function failure(
  result: SpawnSyncReturns<string>,
  code: number,
  message: RegExp,
) {
  assert.equal(result.status, code, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(envelope).sort(), ['code', 'error', 'ok']);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, code);
  assert.match(envelope.error, message);
  assert.equal(result.stderr, `${envelope.error}\n`);
}
