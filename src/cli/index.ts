// Keep the historical import surface while loading the CLI router on demand.
import { spawnSync } from 'node:child_process';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(result.stderr || 'git command failed');
  return result.stdout.trim();
}

function resolvesToCommit(root: string, ref: string): boolean {
  return (
    spawnSync(
      'git',
      [
        '-C',
        root,
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${ref}^{commit}`,
      ],
      { encoding: 'utf8' },
    ).status === 0
  );
}

export function resolveBaseRef(root: string, requested?: string): string {
  const remoteHead = spawnSync(
    'git',
    [
      '-C',
      root,
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ],
    { encoding: 'utf8' },
  );
  const currentBranch = spawnSync(
    'git',
    ['-C', root, 'branch', '--show-current'],
    { encoding: 'utf8' },
  );
  if (requested) {
    if (!resolvesToCommit(root, requested))
      throw new Error(`base ref "${requested}" does not resolve to a commit`);
    return requested;
  }
  if (remoteHead.status === 0) {
    const remoteRef = remoteHead.stdout.trim();
    const localRef = remoteRef.replace(/^origin\//u, '');
    if (resolvesToCommit(root, localRef)) return localRef;
    if (remoteRef !== localRef && resolvesToCommit(root, remoteRef))
      return remoteRef;
    throw new Error(`base ref "${localRef}" does not resolve to a commit`);
  }
  const branch = currentBranch.stdout.trim();
  if (currentBranch.status === 0 && branch) {
    if (!resolvesToCommit(root, branch))
      throw new Error(`base ref "${branch}" does not resolve to a commit`);
    return branch;
  }
  throw new Error('unable to resolve a base ref; specify one with --base');
}

export function gitOutput(root: string, args: string[]): string {
  return git(root, args);
}

export async function dispatch(
  args: string[],
  runtime: { readonly delegate?: import('./delegate.ts').DelegateRuntime } = {},
): Promise<boolean> {
  const [command, ...options] = args;
  if (command === 'start') {
    const { startCommand } = await import('./start.ts');
    await startCommand(options);
  } else if (command === 'checkpoint') {
    const { checkpointCommand } = await import('./checkpoint.ts');
    checkpointCommand(options);
  } else if (command === 'stop') {
    const { stopCommand } = await import('./stop.ts');
    await stopCommand(options);
  } else if (command === 'note') {
    const { noteCommand } = await import('./note.ts');
    await noteCommand(options);
  } else if (command === 'review') {
    const { reviewCommand } = await import('../flow/cli.ts');
    await reviewCommand(options);
  } else if (command === 'delegate') {
    const { delegateCommand } = await import('./delegate.ts');
    await delegateCommand(options, {
      ...runtime.delegate,
      write: runtime.delegate?.write ?? ((text) => process.stdout.write(text)),
    });
  } else if (command === 'task') {
    if (options[0] === 'list') {
      const { taskListCommand } = await import('./task-list.ts');
      await taskListCommand(options.slice(1));
    } else {
      const { taskCommand } = await import('../task/cli.ts');
      taskCommand(options);
    }
  } else return false;
  return true;
}

export async function reportJourneyCommand(args: string[]): Promise<number> {
  const { reportJourneyCommand: run } = await import('./report-journey.ts');
  return run(args);
}
