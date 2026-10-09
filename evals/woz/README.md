# Wizard-of-Oz brain evaluation

This directory preserves the pre-registered input material for KRN's A/B/C/R evaluation of task-scoped brain packets, as required by [ADR 0002](../../docs/adr/0002-brain-v2.md).

- **A:** Luna without a retrieved packet.
- **B:** Luna with the task's applicable packet.
- **C:** Luna with length-matched irrelevant text.
- **R:** Opus without a packet, as the reference arm.

Do not edit `prereg.md` after the first run.

`manifest.json` is the machine-readable run contract. It records each replay base and sealed accepted change, base-verified visible checks, held-out checks and interface coupling, packet/control hashes and sizes, seeded arm order, model IDs, dated pricing status, token estimator, worktree fingerprint, run budgets, and the frozen audit checklist. The current manifest is prepared for freeze; replace its merge and judge SHA placeholders with exact readbacks before the first run. The packet falsifier is `test/woz-manifest.test.ts`; its original red output is retained in `red-test-output.txt`.
