# Lead methods

This procedure expands the always-loaded lead rules in [`AGENTS.md`](../../AGENTS.md). The charter and repository records are the durable sources; ignored session files are working evidence only.

## Find ignored state

When a needed file may be ignored, inspect the repository with:

```sh
git status --ignored --short
git check-ignore -v <path>
rg --no-ignore --hidden '<pattern>' <directory>
```

Use `git ls-files --others --ignored --exclude-standard --directory` when you need a listing of untracked ignored paths. A normal `rg` search omits ignored files, so no result is not proof that a file is absent. Read an ignored file as evidence, then verify its claims in tracked sources or current repository state before treating them as durable facts.

## Resolve sources and verify claims

For decisions, use this order: operator charter, ADR, repository `AGENTS.md`, skill, plan, then working notes. Report a conflict to the owner rather than choosing silently. A proposal is not an accepted decision.

Start verification with the cheapest signal that could disprove the claim. Read current Git or API state before running a focused test; use a judge after deterministic checks, and a milestone review after those. Read back facts copied from old handoffs or plans before acting. Mark facts stale when the readback differs.

When a check fails on a slice, compare the failing file or test with the merge-base. If the same failure exists at the base, report it as pre-existing and keep it separate from the slice diagnosis.

Label analysis claims by evidence class: `[CODE]`, `[VENDOR]`, `[EMPIRICAL]`, `[OURS-EVIDENCE]`, `[HYPOTHESIS]`, or `[POLICY]`. Include a source location or link when one is available; say when evidence is unavailable.

## Stop at gaps and wait for work

At the first missing tool or capability, stop dependent work. Diagnose the gap and present one decision with a recommended path; do not build a chain of alternate tools or unapproved workarounds.

After launching a background task group, issue one blocking wait for the entire group. Do not poll or send progress messages while it runs. Resume when the wait returns a result or a real blocker or decision needs attention. If the wait command reaches its time limit, repeat that same wait without an interim status message.

## Keep proposals and decisions distinct

Record each lead suggestion in the proposal registry with a date, status, and source. Keep accepted, rejected, or superseded status changes visible. Record accepted decisions in the charter, then update the durable repository source that owns the decision, such as an ADR or `spec/rules.json`.

## Change host infrastructure

Before changing host infrastructure, identify the cause from the relevant logs and capture the current state. Make only the action covered by a recorded grant, then capture and read back the resulting state. Stop if the cause, grant scope, or safe readback is missing.
