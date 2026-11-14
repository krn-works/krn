/**
 * The hook command `krn adopt` installs for `krn hook <name>`. Claude Code treats any exit other than 2
 * as non-blocking, so a bare `krn hook <name>` with krn missing from the session PATH (exit 127) would
 * let a worker act unchecked; this command fails closed with exit 2 and says why. It drains the payload
 * with the shell's own `read` first, so the writer never meets a closed pipe.
 */
export function guardCommand(name: string): string {
  const what =
    name === 'stop'
      ? 'Stop hook cannot check this tree'
      : `${name} guard cannot check this call`;
  return `command -v krn >/dev/null 2>&1 || { while read -r _; do :; done; echo 'krn is not on PATH: the KRN ${what}; put krn on PATH for this session' >&2; exit 2; }; exec krn hook ${name}`;
}

/** The Stop hook command: refuses the end of a session while the related tests are red. */
export const stopCommand = guardCommand('stop');

/** The worker guards: tracker and main-checkout writes (scope) and stash-stack changes (stash), with their PreToolUse matchers. */
export const preToolGuards: readonly { matcher: string; command: string }[] = [
  {
    matcher: 'Write|Edit|NotebookEdit|Bash',
    command: guardCommand('scope'),
  },
  { matcher: 'Bash', command: guardCommand('stash') },
];

/** The bare command earlier adoptions installed; adopt replaces it with {@link stopCommand}. */
export const legacyStopCommand = 'krn hook stop';

/** True for a Stop hook command that runs `krn hook stop`, current or legacy. */
export function isKrnStopCommand(command: unknown): boolean {
  return command === stopCommand || command === legacyStopCommand;
}
