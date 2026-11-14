import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stateRoot } from '../../src/context/plan-sample.ts';
import { handleStopFailure } from '../../src/successor/watchdog.ts';

// StopFailure hook: an unattended lead (KRN_UNATTENDED=1) that stopped on quota or an API error is
// relaunched from the newest handoff (src/successor/watchdog.ts). The event's output and exit code are ignored.
function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const cwd = (payload as { cwd?: unknown } | null)?.cwd;
  const root = stateRoot(typeof cwd === 'string' ? cwd : process.cwd());
  if (!root) return;
  const outcome = handleStopFailure(payload, root, process.env, {
    now: Date.now,
    run: (command, args) =>
      spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: 120000 })
        .status,
  });
  process.stderr.write(`krn watchdog: ${JSON.stringify(outcome)}\n`);
}
if (import.meta.main) main();
