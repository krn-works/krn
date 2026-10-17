# Proposal registry

Lead proposals that are not yet operator decisions (KRN-16). Accepted items move to [the charter](charter.md) and to the
durable source that owns them. Status: `proposed` | `accepted` | `rejected` | `superseded`.

| ID | Date | Source | Proposal | Status |
|---|---|---|---|---|
| P-001 | 2026-10-10 | [audit](audit-2026-10-10.md) D1 | Primary metric v2 and kill criterion v2 | accepted (charter 2026-10-10 §1) |
| P-002 | 2026-10-10 | audit D2 | WIP limit until evaluator, env and L2 exit criteria are met | accepted (charter 2026-10-10 §2) |
| P-003 | 2026-10-10 | audit D3 | Evaluator-surface refusal policy | accepted (charter 2026-10-10 §3) |
| P-004 | 2026-10-10 | audit D4 | One non-Luna judge in the judge-calibration experiment only | proposed |
| P-005 | 2026-10-10 | audit D5 | Keep `krn/gate-local` as a required check, recorded as an honor-system attestation | proposed |
| P-006 | 2026-10-10 | audit D6 | Merge the E2 plan (PR #4) after updating it with R1 outcomes | proposed |
| P-007 | 2026-10-10 | audit D8 | Enter E3 (memory) only after a WoZ run meets the preregistered thresholds | proposed |
| P-008 | 2026-10-10 | audit D9 | No distribution beyond the operator for 180 days (CRA, licence, SECURITY.md out of scope) | proposed |
| P-009 | 2026-10-10 | audit §7 | Delete remote branches of closed PRs #2, #3, #7, #9 | proposed (needs deletion grant) |
| P-010 | 2026-10-10 | audit §10 | Enforce SHA pinning in the org Actions policy | proposed (needs org admin) |
| P-012 | 2026-10-10 | Operator ratification recorded for LON-213; lineage: working registry P12 in `.krn/runs/lead/PROPOSALS.md` | Reconcile R1 with Paperclip as sole control plane, `.krn/` lifecycle state, Luna-only repository authorship, fresh-main replay for prior PRs, qualified unattended confinement, and independent exact-SHA Standards/Spec evidence; no wider access from native Goals | accepted (charter 2026-10-10, R1 admission addendum) |
| P-013 | 2026-10-13 | lead synthesis 2026-10-13 | Pi Durable: adopt `requestId` exactly-once and explicit handoff; trial a spike of at most one day after R1 gates (checkpoint per task, `replay:safe`, abort tree); reject hot-swap registry by name and transcript storage (ADR 0009). Keep the KRN core; consider `pi-durable` as an E2 library only after a spike with a falsifier. F-01 is first. | proposed (kierunek przyjęty przez operatora 2026-10-13, formalna ratyfikacja w charterze pending) |
| P-014 | 2026-10-13 | lead synthesis 2026-10-13 | Hygiene order: F-01 → F-03 → L2 → F-05 → branches. Add no modules or hosts until R1-01..05 and L2 exit; continuation of D2. | proposed |
| P-015 | 2026-10-13 | lead synthesis 2026-10-13 | Global setup: establish one role contract sourced from `~/.codex/AGENTS.md`, with short Claude/Pi/T3 adapters; resolve Codex installation drift; audit skills by hash; mechanize KRN-12/13/16/19. | proposed |
| P-016 | 2026-10-13 | lead synthesis 2026-10-13 | Treat T3 Code as a surface (`thread`/`turn`, snapshot plus watch on trace), not the owner of rules; use the same brief, state, and evidence as the terminal. Add Pi as a host only in E2 through the `hosts/` adapter. | proposed |
| P-017 | 2026-10-15 | Operator batch02 grant; LON-275 | Persist the exact prepared checkpoint commit SHA/parent/intent/epoch before HEAD publication, preflight the complete capsule, and reconcile only that owned object through CAS. | accepted (charter batch02; bounded implementation) |
| P-018 | 2026-10-15 | Operator-accepted LON-276 scope | Bound CodexHost onStarted-rejection cleanup to its owned process tree; implementation remains pending review (does not ratify PC-01). | accepted (scope only; code pending review) |
| P-019 | 2026-10-15 | Operator-accepted LON-277 replan scope | Preserve named quoted-credential and Zod protections while admitting ordinary source literals; refuse explicit marker families and structural URI credentials using a finite reference shape set; no generic entropy or DLP claim. | accepted (scope only; code pending review) |
| P-020 | 2026-10-16 | Operator-approved A′; LON-277 | Record bounded linear C1/C2 with b954 short-input differential parity, bounded 80/256 C3 with a distinct analysis-limit refusal, retained C4 debt, and exactly five authorized existing-test outcome changes. | accepted (charter LON-277; code pending review) |
| P-021 | 2026-10-16 | Operator-approved LON-278 scope | Clear only a successfully bound active startup lease after positive exact-owned cancellation acknowledgement; conditional merge after all required exact-head proof, without procedural reapproval. | accepted (charter LON-278; code pending review) |
| P-022 | 2026-10-17 | Operator-approved LON-283 scope | Require a bounded positive systemd unit/cgroup/live-process witness before startup callback; persist and validate it for the existing inactive-scope recovery only; legacy or malformed evidence fails closed; verify pending-launch cancellation and drain; leave W2b deferred. | accepted (charter LON-283; implementation accepted via PR59) |
| P-023 | 2026-10-17 | Operator-approved LON-284 scope | Select host package-manager tooling only from the immutable trusted base while installing and checking candidate manifests, lockfiles, and application dependencies inside the sandbox; preserve existing evaluator protections. | accepted (scope only; charter LON-284; implementation pending) |
