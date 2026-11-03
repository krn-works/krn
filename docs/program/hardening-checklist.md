# Hardening checklist

Every worker brief carries a `## Hardening` section that answers each class below for the inputs and state the change adds or touches, one list item per class: `- <id>: <required behaviour and its readiness case>`, or `- <id>: N/A: <reason>`. `krn brief check <brief>` refuses a brief that misses a class. Every review runs `krn review ... --prepass --checklist docs/program/hardening-checklist.md`, and `krn deliver` refuses a review record made without this file. When a review blocks on a class this list lacks, `krn-retro` adds it here.

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
