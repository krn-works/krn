# Read-only Luna delegation

`krn delegate` runs a finite group of read-only Codex workers from explicit tracked text inputs. It uses the existing `codex exec --json` event stream, waits for every selected worker to finish, stores each result and one group manifest under `.krn/tmp`, then writes one JSON aggregate line to stdout. It does not submit to Paperclip or publish changes.

Run the command from any directory with Node 24 and the KRN checkout available:

```sh
node /path/to/krn/src/cli/main.ts delegate \
  --repo /path/to/repository \
  --input docs/research/brief.md \
  --input src/module.ts \
  --brief "Summarize the interface and its constraints." \
  --brief "Find failure cases in the supplied inputs." \
  --results /path/to/repository/.krn/tmp/delegation/2026-10-19-review \
  --timeout-ms 300000 \
  --concurrency 2
```

`--repo` must name the canonical repository root. Every `--input` must name a tracked, regular, nonsymlink text file inside that repository. `.git`, `.krn` and `.codex` inputs are refused; untracked files are never read. The command stages only those inputs into separate worker directories and disables project instruction discovery for the workers. Each worker runs with `gpt-6-luna`, high reasoning and Codex's `read-only` sandbox. Its working directory contains the selected input copies; the result directory is outside that working directory.

Preflight uses asynchronous Git child processes with a five-second bound per command, bounded output and SIGINT/SIGTERM cancellation; interruption kills and joins the owned Git process before returning exit 130, without starting workers or creating a group result. Each input is opened without following a final symlink, checked against its exact literal tracked path, read through that pinned descriptor with actual-byte limits, and rechecked for path replacement. This detects path swaps and files that grow beyond the byte limit during reading; it does not claim to isolate a hostile process that can modify the same file in place.

Supply one to eight nonempty `--brief` values, one to sixteen `--input` values, a timeout from 1,000 ms to 30 minutes, and concurrency from one to four workers (no greater than the number of briefs). Each input is limited to 2 MiB; all selected inputs together are limited to 8 MiB. `--results` must be a new directory under `<repo>/.krn/tmp`; existing destinations are refused so an earlier result cannot be overwritten.

The result directory contains `worker-N.json` files with each full final response and its terminal state, a `group.json` aggregate manifest, and staged read-only inputs under `workspace/`. Worker status is `completed`, `failed`, `cancelled` or `timeout`. A completion event alone does not count as success: the Codex process must exit zero, report a completed turn, and provide nonempty final text. Each aggregate worker entry has `resultPersisted`; when false, it omits `resultFile`, keeps any available final text in the group result, and records `resultPersistenceErrorType`. The aggregate also reports `manifestPersisted` and its error type when the group file itself could not be written. The command emits its single aggregate JSON line only after workers and result writes settle. A deadline covers host startup as well as the session: startup receives an abort signal and the host settles startup cleanup before the aggregate is emitted. Exit status is 0 when all workers complete and persist, 1 on failure or persistence error, 124 if any worker times out, and 130 if interrupted by SIGINT or SIGTERM.

Use the same command with distinct result paths for separate groups. Do not pass credentials, private histories or untracked source files as input.
