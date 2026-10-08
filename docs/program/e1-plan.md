# E1 / J1 worker plan

**Outcome:** prove that a real, interrupted J1 task resumes in a fresh foreman-started Luna `codex exec` session, then build the board/verdict path and run the first `in_review` pilot. Keep operator minutes, tokens, and limitations in the evidence. No Pi/Claude host, second tracker, merge/acceptance, memory-event capture, or broad KRN work in this outcome.

**Rules:** live operations are opt-in through `npm run live` with `KRN_LIVE=1`; no live test runs in `gate`. The first run (L1) writes nothing to the board. Continuity has one channel: relay writes the existing capsule ABI read by the hook, and foreman passes the absolute path of the new CLI for checkpointing; no install is needed. File-isolated parallel work means separate module and test files; shared contracts are settled in S1 before parallel work. Each task below has one red-first falsifier; its first failure must be an assertion, not a missing import. Quarry paths are read-only source patterns, not authority to mutate their repositories.

## Ordered slices

**Order:** B0 → S1 → S2 → S3 → S4 → L1/G2 → S5 → S6 → S7 → S8 → L2.

### B0 — E1-01: J1 baseline
- **Goal/modules:** record three real, multi-session, interruptible tasks of J1's class in `evals/journeys/j1-baseline.json`: task/repo, operator minutes, reconstruction prompts, first useful action, lost stages, tokens, judge rounds, outcome; retain unknowns.
- **Quarry:** `scripts/lib/harness/e2e-compare.mjs`.
- **Accept:** `n=3`, labeled and read back by the lead. It gates only the first live arm-B run (L1), not implementation; complete before L1.
- **Falsifier (red first):** lead readback rejects a two-row or unlabeled baseline record.
- **Depends/parallel group:** none; parallel with S1–S4, isolated `evals/` files.

### S1 — E1-02: core and shared contracts
- **Goal/modules:** `core` defines `Job {id,issue,worktree}`, `Result`, and Zod parsing for Paperclip payloads; define typed `Deps` in `foreman/run.ts`. No status or epoch in `Job`; status is a ledger `BoardView`, epoch belongs to the capsule/relay lease. Include the agreed B3/B6 boundary fixes.
- **Quarry:** `scripts/lib/state/capsule-abi.mjs`; `scripts/lib/contract/change-contract.mjs`; `krn-factory/src/lifecycle.ts`.
- **Accept:** malformed Paperclip payload returns `Result.error`; board status and fencing are not duplicated in `Job`.
- **Falsifier (red first):** `node --test test/core/job.test.ts` asserts a malformed payload returns `Result.error`, not a thrown exception.
- **Depends/parallel group:** none; parallel with B0, then S2–S4 in isolated module/test files.

### S2 — E1-06: Luna Codex host
- **Goal/modules:** `hosts/codex` starts, waits, and cancels a stable session; bounds output and parses token telemetry. Exercise a real Luna invocation only through opt-in `npm run live` (`KRN_LIVE=1`).
- **Quarry:** `krn-factory/src/codex-executor.ts`, `process.ts`, `supervised-executor.ts`; `feat/krn-run-minimal:scripts/lib/run/run-worker.mjs`.
- **Accept:** unit path reaps the process tree and preserves session identity; live path reports Luna and tokens without persisting transcripts.
- **Falsifier (red first):** `node --test test/hosts/codex-cancel.test.ts` asserts cancellation kills a fake process tree.
- **Depends/parallel group:** S1; parallel with S3–S4 in isolated host/test files.

### S3 — E1-04: relay and capsule continuity
- **Goal/modules:** `relay` loads, validates, refreshes, projects, and writes the capsule through the existing `capsule-abi.mjs` ABI and hook path; read-only ADR/CONTEXT/skill pointers; capsule holds contract revision, repo anchors, next action, blockers, dated decisions and rejected approaches. CAS fences epoch; projection ≤2k tokens. No transcript or memory-event writes.
- **Quarry:** `scripts/lib/state/capsule-abi.mjs`, `state-brief.mjs`, `state-check.mjs`; `scripts/hooks/krn_capsule.py`.
- **Accept:** hook and relay use that single capsule channel; stale contract/epoch stops safely.
- **Falsifier (red first):** `node --test test/relay/capsule-cas.test.ts` asserts a stale-epoch write is rejected.
- **Depends/parallel group:** S1; parallel with S2 and S4 in isolated relay/test files.

### S4 — E1-07: bounded foreman and first live acceptance
- **Goal/modules:** `foreman.runJob` composes relay, trace, and host; `trace` starts append-only JSONL intent/session/end events and operator start/stop; `krn start` creates the worktree. Write intent before start, checkpoint on interruption, resume in a fresh session, enforce idempotency, max 3 resets/epoch and ≤2 repairs, then `human_decision`. Pass the absolute path of the new CLI to the worker for `checkpoint`; no global install.
- **Quarry:** `feat/krn-run-minimal:scripts/lib/run/{run-cli,run-worker}.mjs`; `scripts/lib/state/state-check.mjs`; `krn-factory/src/{durable-store,recovery,supervisor}.ts`.
- **Accept:** `run.ts` ≤40 lines excluding helper I/O; local falsifier passes. **This is the acceptance of step 5 and gate G2:** L1 resumes one real interrupted issue after checkpoint in a fresh Luna session, exactly once, with `n=1` pilot evidence and no board writes. B0 must be read back before L1. L1 runs only via `npm run live` with `KRN_LIVE=1`.
- **Falsifier (red first):** `node --test test/foreman/interrupted-resume.test.ts` asserts kill-after-checkpoint leads to one action in a new session ID.
- **Depends/parallel group:** S1–S3; file-isolated with those slices. L1 follows their integration; no parallel live run.

### S5 — E1-03: board-only ledger
- **Goal/modules:** `ledger` reads issue contract and conditionally submits `in_review`; Paperclip alone owns status, assignment, and acceptance.
- **Quarry:** `scripts/lib/paperclip/api-filter.mjs`; `scripts/lib/paperclip/qualification.mjs`; `scripts/lib/paperclip/publisher-gateway.mjs`; `krn-factory/src/reviewer-gate.ts`.
- **Accept:** exact issue/revision binding and visible readback; unavailable or stale board cannot write; no direct Git/PR publisher path.
- **Falsifier (red first):** `node --test test/ledger/board-only.test.ts` asserts credential-less or non-allowlisted mutation is refused.
- **Residual risk:** Paperclip issue PATCH has no revision precondition, so a detected concurrent board write is corrected and returned for human review; the write remains non-atomic.
- **Depends/parallel group:** L1/G2; isolated ledger/test files.

### S6 — E1-08: exact-SHA verdict
- **Goal/modules:** `verdict` binds deterministic gates and Luna judge evidence to one SHA; only complete positive evidence may call ledger submit.
- **Quarry:** `scripts/lib/contract/gated-transition.mjs`, `change-contract.mjs`; `feat/krn-run-minimal:test/run/run.test.mjs`; `krn-factory/src/verifier.ts`, `reviewer-gate.ts`.
- **Accept:** evidence records exact SHA; Luna reviews nondeterministic claims only; no self-review or status authority.
- **Falsifier (red first):** `node --test test/verdict/exact-sha.test.ts` asserts submission is refused after HEAD changes.
- **Depends/parallel group:** S1, S5; isolated verdict/test files.

### S7 — E1-05: trace replay and report
- **Goal/modules:** complete `trace` JSONL replay/report for intent/session/end/verdict and operator time; capture tokens from `codex exec --json`. Never store task status or transcripts.
- **Quarry:** `scripts/lib/harness/e2e-compare.mjs`; `krn-factory/src/usage-ledger.ts`, `codex-executor.ts`, `durable-store.ts`.
- **Accept:** close/reopen preserves ordered events and reports minutes/tokens for L1 and later live work.
- **Falsifier (red first):** `node --test test/trace/reopen.test.ts` asserts a missing event after close/reopen is detected.
- **Depends/parallel group:** S4, S6; isolated trace/report files.

### S8 — E1-09: CLI forwarder hardening
- **Goal/modules:** `cli` routes J1 commands to foreman; unknown commands forward to `krn-legacy` with argument/stdio/exit parity and recursion guard. No target install in this slice.
- **Quarry:** `feat/krn-run-minimal:scripts/lib/run/run-cli.mjs`, `scripts/krn.mjs`, `test/run/run.test.mjs`; `scripts/hooks/krn_capsule.py`.
- **Accept:** migrated J1 commands use new CLI; hook check precedes any separately authorized bin swap; foreman supplies its absolute CLI path for checkpointing.
- **Falsifier (red first):** `node --test test/cli/legacy-entry.test.ts` asserts default `KRN_LEGACY_ENTRY` and realpath handling route to the intended binary.
- **Depends/parallel group:** S4; isolated CLI/test files.

### L2 — E1-10: first live `in_review` run
- **Goal/modules:** integrated `core,relay,foreman,ledger,verdict,trace,hosts/codex,cli`; run one authorized real issue, interrupt after checkpoint, resume in fresh foreman-started Luna session, then record evidence and perform read-only board readback.
- **Quarry:** `feat/krn-run-minimal:scripts/lib/run/{run-cli,run-worker}.mjs`; `scripts/hooks/krn_capsule.py`; `krn-factory/src/{codex-executor,durable-store,recovery,usage-ledger}.ts`.
- **Accept:** exact issue/contract/SHA, gate and verdict evidence, Paperclip `in_review` readback, minutes/tokens; record `n=1`, pilot label and limits in `evals/journeys/j1-first-live.json`. This does not establish E1 improvement or exit. Run only with `npm run live` and `KRN_LIVE=1`, never as a test in `gate`.
- **Falsifier (red first):** `npm run live` asserts the second real session resumes once and read-only board readback is `in_review` for that SHA.
- **Depends/parallel group:** B0 and S1–S8; pilot grants/qualification must be complete; isolated evidence file, no parallel live operation.

**Boundary:** E1 ends at L2. Blueprint §12 exit still requires ≥3 accepted outcomes and median operator minutes per outcome ≥30% below the same-class baseline, with zero lost obligations or unauthorized effects. `in_review` alone proves none of these. Paperclip UI disposition, independent review, restore, and later acceptance remain their owners’ gates.

## Zmiany po G1

- L1 moved to S4 acceptance and G2: real resume precedes ledger/verdict and makes no board writes.
- Live operations are opt-in via `npm run live` (`KRN_LIVE=1`), outside `gate`.
- Continuity uses the existing capsule ABI as its sole channel; checkpoint uses the absolute new CLI path, with no install.
- B0 is three interruptible, multi-session J1-class tasks and gates only L1.
