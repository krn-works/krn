import { spawnSync } from 'node:child_process';
import { runCanary, touchesLane } from '../src/cli/lane-canary.ts';

// Runs the lane canary when a lane, adopt or ci path changed (logic: src/cli/lane-canary.ts).
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
