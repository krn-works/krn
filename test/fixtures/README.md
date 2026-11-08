# Receiver captures

KRN-12 captures are committed verbatim except for redaction, and redaction has one sanctioned form.

- A host path (repository root, home or runtime directory) becomes the placeholder `/work/repo`.
- A Claude transcript `cwd` becomes `.`, and transcript message content becomes `[]`.
- Nothing else is rewritten: ids, counters, key order and byte format stay as captured.

`/work/repo` is not a forbidden root, so the host-path guard (`test/rules/host-path-guard.test.mjs`) accepts it and pins that in a test. Reviewers treat the placeholder as verbatim and flag only other edits.

`scripts/claude/capture-fixture.ts` applies the convention to Claude transcript JSONL: `node scripts/claude/capture-fixture.ts <transcript.jsonl>` writes fixture lines to stdout. `test/claude/capture-fixture.test.ts` proves the fixtures under `test/claude/fixtures` are unchanged by it. Herdr replies under `test/fixtures/herdr` use the same placeholder.
