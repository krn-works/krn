// Command router; each command loads on demand.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function productRoot(): string {
  return realpathSync(fileURLToPath(new URL('../..', import.meta.url))).replace(
    /\/$/u,
    '',
  );
}

export async function dispatch(args: string[]): Promise<boolean> {
  const [command, ...options] = args;
  if (command === 'ledger') {
    const { ledgerCommand } = await import('./ledger.ts');
    await ledgerCommand(options);
  } else if (command === 'review') {
    const { reviewCommand } = await import('../flow/cli.ts');
    await reviewCommand(options);
  } else if (command === 'ci') {
    const { ciCommand } = await import('./ci.ts');
    await ciCommand(options);
  } else if (command === 'worker') {
    const { workerCommand } = await import('../worker/cli.ts');
    await workerCommand(options);
  } else if (command === 'task') {
    if (process.env.KRN_FORWARDED !== undefined) {
      // The host entry forwarded this call: refuse a stale or unpinned build.
      const pin = await import('./entry-pin.ts');
      const state = pin.readEntryPin(productRoot());
      if (!pin.isFresh(state)) {
        process.stderr.write(pin.staleEntryMessage(state));
        process.exitCode = pin.staleEntryExit;
        return true;
      }
    }
    const { taskCommand } = await import('../task/cli.ts');
    await taskCommand(options);
  } else if (command === 'lane') {
    const { laneCommand } = await import('./lane.ts');
    await laneCommand(options);
  } else if (command === 'state') {
    const { stateCommand } = await import('./state.ts');
    stateCommand(options);
  } else if (command === 'doctor') {
    const pin = await import('./entry-pin.ts');
    const report = pin.doctorReport(pin.configuredEntryRoot());
    process.stdout.write(report.text);
    process.exitCode = report.exitCode;
  } else if (command === 'brain') {
    const { brainCommand } = await import('../brain/cli.ts');
    await brainCommand(options);
  } else if (command === 'eval') {
    const { evalCommand } = await import('../evals/cli.ts');
    await evalCommand(options);
  } else return false;
  return true;
}
