# LON-214 process-local confinement

`confine.sh <task-worktree> <task-run-dir> [--runtime-max-sec N] -- <command...>` runs a command in bwrap under a transient user systemd scope (default 2700 seconds). It resolves and bounds both writable task paths to this checkout, clears inherited variables, keeps networking available, and uses pinned Node 24.21.0 first on PATH. `qualify.sh` runs the direct observer and prints the later real-agent command; it does not launch a model.

## Writable and hidden mounts

| Path | Access | Reason |
| --- | --- | --- |
| `/` | read-only | Baseline view of host filesystem and executables |
| task worktree | read-write | Worker source changes |
| task run directory | read-write | Task evidence and observer inputs |
| `/tmp` | private tmpfs, read-write | Temporary CLI/runtime files; no host `/tmp` visibility |
| `/home/krn/.codex` | private tmpfs, read-write | Isolated CLI session, logs, and temporary state |
| Codex release directory | read-only | Pinned CLI executable and its packaged runtime |
| `/home/krn/.codex/auth.json` | read-only, if present | Codex API authentication required to call the model |
| `/home/krn/.paperclip` | hidden by tmpfs, when present | Board state/credentials |
| `/home/krn/.config/gh` | hidden by tmpfs, when present | GitHub CLI credentials/config |
| `/home/krn/.config/krn` | hidden by tmpfs, when present | KRN/Paperclip CLI state |
| `/home/krn/.config/paperclip` | hidden by tmpfs, when present | Paperclip CLI state |
| `/home/krn/.local/share/krn` | hidden by tmpfs, when present | KRN/Paperclip CLI state |
| `/home/krn/.local/state/krn` | hidden by tmpfs, when present | KRN/Paperclip CLI state |

`/dev` and `/proc` are scoped pseudo-filesystems; `/proc` supplies the cgroup evidence. Environment is rebuilt as `HOME`, `CODEX_HOME`, `PATH`, `LANG`, `TERM`, and `KRN_CONFINE_*` observer metadata. No proxy variables or caller credentials are carried through.

## Limits and evidence

The model API network is open. The CLI's `auth.json` is readable to the CLI and every command it starts; that is necessary for this direct CLI arrangement and is **not acceptable for a hostile agent that could steal provider credentials over the network**. Qualification evidence must state this boundary; a stronger threat model needs credential mediation or a broker. Other providers need their own narrowly selected auth/session mounts before use. Filesystem confinement does not constrain network destinations or prove application-level authorization.

The lead captures `qualify.sh` output, the exact `KRN_CONFINE_JSON` line, wrapper/script hashes, pinned Codex version, systemd unit and `RuntimeMaxSec`, worktree/run-dir paths, and whether the separately supervised real-agent observer emitted the same line. Direct observer success alone is not backend qualification or R1 READY.
