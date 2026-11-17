import { spawnSync } from 'node:child_process';

const unit = 'bw-serve.service';

/** Runs a command and returns its stdout, or '' when it cannot run; tests replace it. */
export type Run = (command: string, args: string[]) => string;

const spawnRun: Run = (command, args) =>
  spawnSync(command, args, { encoding: 'utf8', timeout: 10000 }).stdout ?? '';

/** The unit state word: `absent`, `failed`, `inactive` or `active`, from `systemctl --user show` output. */
export function unitState(show: string): string {
  const field = (name: string) =>
    new RegExp(`^${name}=(.*)$`, 'mu').exec(show)?.[1]?.trim();
  if (field('LoadState') === 'not-found') return 'absent';
  return field('ActiveState') ?? 'unknown';
}

/** The last journal line that reports an error, else the last line. */
export function lastJournalError(journal: string): string | undefined {
  const lines = journal
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const last = (pattern: RegExp) =>
    [...lines].reverse().find((line) => pattern.test(line));
  // The cause (an Error: line, EADDRINUSE) outranks the generic systemd failure lines after it.
  return (
    last(/^error\b|EADDR|denied/iu) ?? last(/error|fail/iu) ?? lines.at(-1)
  );
}

/**
 * Why bw serve does not answer: the bw-serve unit state and its last journal error line, with the
 * remedy. `bw-up` is an operator command of an interactive shell; an agent never runs it.
 */
export function describeBwServe(run: Run = spawnRun): string {
  const show = run('systemctl', [
    '--user',
    'show',
    unit,
    '-p',
    'LoadState,ActiveState,SubState,Result',
  ]);
  const state = unitState(show);
  const journal =
    state === 'absent'
      ? undefined
      : lastJournalError(
          run('journalctl', [
            '--user',
            '-u',
            unit,
            '-n',
            '20',
            '--no-pager',
            '-o',
            'cat',
          ]),
        );
  return `${unit} is ${state}${journal ? `, last journal line: ${journal}` : ''}; bw-up is an operator command for an interactive shell, an agent does not run it`;
}

/** The `status` field of a bw serve GET /status body, or undefined when the body is not one. */
export function vaultStatus(body: string): string | undefined {
  try {
    const status = (
      JSON.parse(body) as { data?: { template?: { status?: unknown } } }
    ).data?.template?.status;
    return typeof status === 'string' ? status : undefined;
  } catch {
    return undefined;
  }
}
