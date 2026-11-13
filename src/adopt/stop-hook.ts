/**
 * The Stop hook command `krn adopt` installs. Claude Code treats any exit other than 2 as
 * non-blocking, so a bare `krn hook stop` with krn missing from the session PATH (exit 127)
 * would let a worker stop unchecked; this command fails closed with exit 2 and says why. It
 * drains the payload with the shell's own `read` first, so the writer never meets a closed pipe.
 */
export const stopCommand =
  "command -v krn >/dev/null 2>&1 || { while read -r _; do :; done; echo 'krn is not on PATH: the KRN Stop hook cannot check this tree; put krn on PATH for this session' >&2; exit 2; }; exec krn hook stop";

/** The bare command earlier adoptions installed; adopt replaces it with {@link stopCommand}. */
export const legacyStopCommand = 'krn hook stop';

/** True for a Stop hook command that runs `krn hook stop`, current or legacy. */
export function isKrnStopCommand(command: unknown): boolean {
  return command === stopCommand || command === legacyStopCommand;
}
