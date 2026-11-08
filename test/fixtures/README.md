# Receiver captures

KRN-12 captures are committed verbatim except for redaction, and redaction has one sanctioned form.

- A host path (repository root, home or runtime directory) becomes the placeholder `/work/repo`.
- A Claude transcript `cwd` becomes `.`, and transcript message content becomes `[]`.
- Nothing else is rewritten: ids, counters, key order and byte format stay as captured.
- A compact JSON capture, such as raw `gh api` output, is listed in its directory's `.ignore` so Biome skips it; otherwise `npm run fast` (Biome `--write`) reformats it.

`/work/repo` is not a forbidden root, so the host-path guard (`test/rules/host-path-guard.test.mjs`) accepts it and pins that in a test. Reviewers treat the placeholder as verbatim and flag only other edits.

A Herdr capture also records its stream. The CLI prints a reply on stdout and a server error as JSON on stderr with exit 1 (Herdr CLI reference, "Output waits"), so `*.reply.jsonl` holds stdout, `*.stderr.jsonl` holds stderr, and a stub prints each on the stream its name says.

`scripts/claude/capture-fixture.ts` applies the convention to Claude transcript JSONL: `node scripts/claude/capture-fixture.ts <transcript.jsonl>` writes fixture lines to stdout. `test/claude/capture-fixture.test.ts` proves the fixtures under `test/claude/fixtures` are unchanged by it. Herdr replies under `test/fixtures/herdr` use the same placeholder.

A Codex eval capture under `test/fixtures/eval/codex-<version>` keeps stdout (`*.stdout.jsonl`) and stderr (`*.stderr.log`) byte for byte; `provenance.json` records the command, receiver version, exit code and sha256 of every file, and `test/evals/codex-captures.test.ts` fails when a file changes or is not listed.

A Codex app-server replay transcript under `test/fixtures/codex-app-server` holds one JSON-RPC frame per line: `> ` and what KRN wrote, `< ` and what Codex wrote, byte for byte except the placeholder, which also stands for the Codex home. `KRN_LIVE=1 node scripts/live-worker.mjs --record` runs every scenario in `scripts/codex/worker-scenarios.ts` through `scripts/codex/app-server-replay.ts` against the real receiver and rewrites `provenance.json` (receiver, command, sha256 of every transcript). `test/worker/codex-replay.test.ts` replays each transcript under the real CLI, driver and `CodexAppServer`, and names the first frame KRN writes differently; a change to what KRN sends needs a new recording, not an edited transcript.
