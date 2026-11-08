import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { accountKey } from '../../scripts/codex/app-server-replay.ts';
import {
  type MockProvider,
  type MockReply,
  mockProviderConfig,
  startMockProvider,
} from '../../scripts/codex/mock-responses.ts';
import {
  type Played,
  play,
  problems,
  type Scenario,
} from '../../scripts/codex/worker-scenarios.ts';
import { stubSystemd } from './session-fixture.ts';

// KRN-12 receiver proof without an account: the real codex binary runs
// app-server turns through `krn worker` against a scripted Responses
// provider on loopback (scripts/codex/mock-responses.ts). CI installs the
// pinned binary (.github/actions/setup-ci); a missing binary fails here.
const supported: readonly string[] = JSON.parse(
  readFileSync('spec/worker-scope.json', 'utf8'),
).supportedVersions;

export const report = JSON.stringify({
  status: 'done',
  summary: 'mock provider answered',
  changed_paths: [],
  checks: [],
  findings: [],
  unverified: [],
  blockers: [],
});

export type Run = {
  readonly played: Played;
  readonly provider: MockProvider;
  readonly frames: readonly string[];
  result(round: string): Record<string, unknown>;
};

/** Plays scenario through the real codex against replies; no frame may carry account state. */
export async function run(
  t: TestContext,
  scenario: Scenario,
  replies: readonly MockReply[],
): Promise<Run> {
  const codex = process.env.KRN_TEST_CODEX_BIN || 'codex';
  const version = spawnSync(codex, ['--version'], { encoding: 'utf8' });
  assert.equal(
    version.error,
    undefined,
    `${codex} is not runnable; install codex ${supported.join(' or ')}`,
  );
  assert.ok(
    supported.some((pinned) => version.stdout.trim().endsWith(` ${pinned}`)),
    `${codex} reports ${version.stdout.trim()}; expected ${supported.join(' or ')}`,
  );

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'krn-mock-provider-')));
  const provider = await startMockProvider(replies);
  t.after(async () => {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  });
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const codexHome = join(root, 'codex-home');
  for (const dir of [bin, home, codexHome]) mkdirSync(dir);
  stubSystemd(bin);
  writeFileSync(
    join(codexHome, 'config.toml'),
    mockProviderConfig(provider.baseUrl),
  );
  // Only what the receiver needs: no operator home, key or account.
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    CODEX_HOME: codexHome,
    CODEX_KRN_TARGET: codex,
    TMPDIR: root,
  };
  const played = await play(scenario, root, env);
  assert.deepEqual(problems(scenario, played), []);
  const frames = readFileSync(played.log, 'utf8').split('\n');
  assert.deepEqual(
    frames.filter((line) => accountKey.test(line)),
    [],
    'a frame carries account state',
  );
  return {
    played,
    provider,
    frames,
    result: (round) =>
      JSON.parse(
        readFileSync(join(played.run, `rounds/${round}/result.json`), 'utf8'),
      ),
  };
}

export const requests = (provider: MockProvider) =>
  provider.requests.map((request) => `${request.method} ${request.path}`);

/** Inbound frames of method, parsed from the transcript. */
export const inbound = (frames: readonly string[], method: string) =>
  frames
    .filter((line) => line.startsWith('< '))
    .map((line) => JSON.parse(line.slice(2)))
    .filter((frame) => frame.method === method);
