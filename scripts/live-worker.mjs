import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveCodexExecutable } from '../src/hosts/codex.ts';
import { play, problems, scenarios } from './codex/worker-scenarios.ts';

// Paid live smoke: runs every worker scenario against the real Codex
// app-server through the recorder. --record also refreshes the replay
// transcripts under test/fixtures/codex-app-server.
const args = process.argv.slice(2);
if (process.env.KRN_LIVE !== '1' || args.some((arg) => arg !== '--record')) {
  console.error('usage: KRN_LIVE=1 node scripts/live-worker.mjs [--record]');
  process.exit(64);
}
const parent = resolve('.krn/runs');
mkdirSync(parent, { recursive: true });
const evidence = mkdtempSync(join(parent, 'worker-live-'));
const target = resolveCodexExecutable();
const failures = [];
const captures = [];
for (const scenario of scenarios) {
  const root = join(evidence, scenario.name);
  mkdirSync(root);
  const played = await play(scenario, root, {
    ...process.env,
    CODEX_KRN_TARGET: target,
  });
  failures.push(...problems(scenario, played));
  captures.push({ scenario, log: played.log });
}
if (args.includes('--record')) {
  const fixtures = resolve('test/fixtures/codex-app-server');
  mkdirSync(fixtures, { recursive: true });
  const receiver = spawnSync(target, ['--version'], {
    encoding: 'utf8',
  }).stdout.trim();
  for (const { scenario, log } of captures)
    copyFileSync(log, join(fixtures, `${scenario.name}.rpc`));
  const provenance = {
    receiver,
    captured: new Date().toISOString().slice(0, 10),
    command: 'KRN_LIVE=1 node scripts/live-worker.mjs --record',
    setup:
      'scripts/codex/worker-scenarios.ts runs each scenario: a git repository with spec/worker-scope.json and a.txt in one commit, then the krn worker steps with KRN_CODEX_BIN on scripts/codex/app-server-replay.ts, which runs the real app-server in between and logs every frame.',
    captures: captures.map(({ scenario, log }) => ({
      name: scenario.name,
      question: scenario.question,
      file: `${scenario.name}.rpc`,
      sha256: createHash('sha256').update(readFileSync(log)).digest('hex'),
    })),
  };
  writeFileSync(
    join(fixtures, 'provenance.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
}
console.log(`live worker evidence: ${evidence}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
