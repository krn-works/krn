# Hardening checklist

Optional aid for `krn review ... --prepass --checklist docs/program/hardening-checklist.md` and for writing a worker brief: answer each class below for the inputs and state the change adds or touches. Nothing refuses a change that skips it. When a review blocks on a class this list lacks, `krn-retro` adds it here.

- `symlink`: a symlink or non-directory at every created or read path, ancestors included, is refused or never followed out of its root (`lstat`, `O_NOFOLLOW`, realpath equals the expected path).
- `malformed`: a malformed, partial or empty record is treated as missing, is reported, and never blocks the valid records beside it.
- `crash`: a crash between create and write, or between two writes, leaves state the next run detects and repairs (write to a temporary file, then rename).
- `race`: concurrent runs and time-of-check to time-of-use gaps are closed (`O_EXCL`, lock, re-read after wait).
- `bounds`: every persisted, derived or printed field has a byte or count bound, and input beyond it is refused, not truncated silently.
- `exit-codes`: every error path has a stated exit code (64 usage, 65 invalid data, 70 internal, 75 held or temporary) and a message on stderr.
- `text-grammar`: parsed text handles repeated sections, fenced code, 0-3 space indent, CRLF, a BOM and control characters.
- `secrets`: values that may hold credentials, multiline ones included, are redacted before they are logged, persisted or forwarded.
- `trust`: code, configuration and records read from a PR head or another untrusted tree are never executed or trusted as policy.
- `text-scanner`: a guard that scans source text (Markdown, JavaScript, shell) states its contract as the concrete shapes it must catch, each with a fixture, and declares full lexer or parser completeness (escapes, multi-line templates, regex literals, CommonMark fence variants beyond those shapes) a non-goal before the first review; input it cannot classify fails closed (refused with exit 65), never passes.
- `identity`: process-lifecycle code verifies a process's identity before it signals, waits on or adopts it: the pid's start time and command line, plus the service unit or name pattern, must match what this run recorded; pid files, sockets and state that the supervised process can write are never trusted as proof of identity.
- `stale-state`: artefacts left by an earlier session (pid files, sockets, locks, inbox records, partial runs) are tagged with a session id and refused or ignored when the id differs; a start refused for stale state spawns nothing and leaves no new artefact behind.
- `one-line-text`: untrusted external text printed or persisted as one line (check output, API fields, logs, causes) is cut at the first LF, CR, U+2028 or U+2029 and drops Cc and Cf characters before it is printed, each shape with a fixture.
- `superseded-wording`: a change that amends a decision (an ADR amendment, a new decision that narrows or replaces a gate) updates in the same PR every sentence in the amended ADRs, their index rows and the rules that still state the old gate, found by a `git grep` for the old gate's wording, so no section (Deferred, Consequences, Status) keeps the superseded wording.
