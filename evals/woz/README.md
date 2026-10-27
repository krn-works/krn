# Wizard-of-Oz brain evaluation

This directory preserves the pre-registered input material for KRN's A/B/C/R evaluation of task-scoped brain packets, as required by [ADR 0002](../../docs/adr/0002-brain-v2.md).

- **A:** Luna without a retrieved packet.
- **B:** Luna with the task's applicable packet.
- **C:** Luna with length-matched irrelevant text.
- **R:** Opus without a packet, as the reference arm.

Do not edit `prereg.md` after the first run.

## Input status versus experiment runs (2026-10-20)

This directory contains preregistered inputs, not proof that A/B/C/R ran. The product ADR's proposed thresholds conflict with the frozen [`prereg.md`](prereg.md); resolve that conflict before the first run, with no post-result threshold change. FR-40 (ADR 0014 D20) is the gate; the Wizard-of-Oz set is a harness pilot only.
