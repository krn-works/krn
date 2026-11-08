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
import { test } from 'node:test';
import { accountKey } from '../../scripts/codex/app-server-replay.ts';
import {
  assistantReply,
  mockProviderConfig,
  startMockProvider,
} from '../../scripts/codex/mock-responses.ts';
import {
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

const report = {
  status: 'done',
  summary: 'mock provider answered',
  changed_paths: [],
  checks: [],
  findings: [],
  unverified: [],
  blockers: [],
};

const scenario: Scenario = {
  name: 'mock-provider',
  question: 'Does one worker turn reach the provider and end with its report?',
  steps: [
    {
      command: 'start',
      text: 'Do not change files.\nReturn a complete worker report.',
      exit: 0,
    },
    { command: 'stop', exit: 0 },
  ],
};

test('the real codex app-server runs a worker turn against a mock Responses provider', async (t) => {
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
  const provider = await startMockProvider([
    assistantReply('resp-1', JSON.stringify(report)),
  ]);
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
  // One turn is one streamed request with the brief and the report schema.
  assert.deepEqual(
    provider.requests.map((request) => `${request.method} ${request.path}`),
    ['POST /v1/responses'],
  );
  const turn = provider.requests[0]?.body as {
    model?: string;
    stream?: boolean;
    text?: { format?: { type?: string } };
  };
  assert.equal(turn.model, 'gpt-6-luna');
  assert.equal(turn.stream, true);
  assert.equal(turn.text?.format?.type, 'json_schema');
  assert.match(JSON.stringify(turn), /Return a complete worker report\./u);
  const written = JSON.parse(
    readFileSync(join(played.run, 'rounds/001/report.json'), 'utf8'),
  );
  assert.equal(written.summary, report.summary);
  const frames = readFileSync(played.log, 'utf8').split('\n');
  assert.deepEqual(
    frames.filter((line) => accountKey.test(line)),
    [],
    'a frame carries account state',
  );
});
