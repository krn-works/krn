// Command router; each command loads on demand.
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
    const { taskCommand } = await import('../task/cli.ts');
    await taskCommand(options);
  } else if (command === 'eval') {
    const { evalCommand } = await import('../evals/cli.ts');
    await evalCommand(options);
  } else return false;
  return true;
}
