import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLane } from '../src/cli/lane.ts';
import { laneRunCommand } from '../src/cli/lane-run.ts';

/** Paths whose change can break `krn lane run`: the lane commands, adoption and the CI client. */
export const CANARY_PATHS = [
  /^src\/cli\/lane/u,
  /^src\/adopt\//u,
  /^src\/ci\//u,
];

export function touchesLane(paths: string[]): boolean {
  return paths.some((path) => CANARY_PATHS.some((re) => re.test(path)));
}

const TASK = 't-canary1';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Runs one lane against a local pilot repository (a git clone of a bare origin
 * holding one open task). The session is a stand-in `claude` that commits with
 * the Ticket trailer; with `deliver: false` it commits nothing, which a working
 * lane must report as a failure. Returns the lane's exit code and line.
 */
export async function runCanary(
  options: { deliver?: boolean } = {},
): Promise<{ exitCode: number; line: string }> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-lane-canary-')));
  const previous = process.env.KRN_LANE_CLAUDE;
  try {
    const origin = join(base, 'origin.git');
    const repo = join(base, 'repo');
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    git(base, 'clone', '-q', origin, repo);
    git(repo, 'config', 'user.name', 'lane canary');
    git(repo, 'config', 'user.email', 'canary@example.invalid');
    git(repo, 'checkout', '-q', '-b', 'main');
    mkdirSync(join(repo, 'tasks'));
    writeFileSync(
      join(repo, 'tasks', `${TASK}.json`),
      `${JSON.stringify(
        {
          id: TASK,
          status: 'open',
          resolution: null,
          created: '2026-11-14',
          priority: 3,
          title: 'Canary task',
          after: [],
          body: ['Outcome: the canary lane delivers a commit'],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(repo, '.gitignore'), '.krn\nnode_modules\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'seed');
    git(repo, 'push', '-q', 'origin', 'main');
    const fastCheck = new URL('./fast-check.ts', import.meta.url).pathname;
    const marker = `node --input-type=module -e "import { treeKey } from '${fastCheck}'; import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('.krn/cache', { recursive: true }); writeFileSync('.krn/cache/fast-pass', treeKey(process.cwd()));"`;
    const close = `node -e "const fs = require('node:fs'); const f = 'tasks/${TASK}.json'; const t = JSON.parse(fs.readFileSync(f, 'utf8')); t.status = 'closed'; t.resolution = { kind: 'done', ref: null, note: '' }; fs.writeFileSync(f, JSON.stringify(t, null, 2) + '\\n');"`;
    const action =
      options.deliver === false
        ? 'true'
        : `${close}; git commit -qam "feat(x): done (${TASK})" -m "Ticket: ${TASK}"; ${marker}`;
    const claude = join(base, 'claude');
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      result: 'done',
    });
    writeFileSync(
      claude,
      `#!/bin/sh\n${action}\ncat <<'JSON'\n${result}\nJSON\n`,
    );
    chmodSync(claude, 0o755);
    process.env.KRN_LANE_CLAUDE = claude;
    const verdict = await laneRunCommand(['--task', TASK, '--root', repo], {
      start: startLane,
      ship: async () => 'merged\nverdict: merged canary',
      mint: async () => undefined,
    });
    return { exitCode: verdict.exitCode, line: verdict.line };
  } finally {
    if (previous === undefined) delete process.env.KRN_LANE_CLAUDE;
    else process.env.KRN_LANE_CLAUDE = previous;
    rmSync(base, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  for (const name of ['KRN_SESSION_CLASS', 'KRN_LANE', 'KRN_TASK'])
    delete process.env[name];
  const baseRef = process.argv[2] ?? 'origin/main';
  const changed = spawnSync(
    'git',
    ['diff', '--name-only', `${baseRef}...HEAD`],
    {
      encoding: 'utf8',
    },
  );
  if (changed.status !== 0) {
    console.error(`lane-canary: git diff failed: ${changed.stderr}`);
    process.exit(2);
  }
  if (!touchesLane(changed.stdout.split('\n').filter(Boolean))) {
    console.log('lane-canary: SKIP no lane, adopt or ci path changed');
  } else {
    const { exitCode, line } = await runCanary();
    console.log(`lane-canary: ${exitCode === 0 ? 'PASS' : 'FAIL'} ${line}`);
    process.exit(exitCode);
  }
}
