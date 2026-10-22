# 13. Repository consolidation

Date: 2026-10-22

## Status

Accepted direction; the consolidation trigger has not fired. This ADR selects
the target and records the conditions and window for a later consolidation;
it does not move code now.

## Context

**[CODE: Product `src/cli/main.ts`; Product `AGENTS.md` KRN-06]** The CLI
forwards unknown commands to the configured legacy entry with a recursion
guard. This strangler seam is transitional and needs an explicit exit
condition.

**[EMPIRICAL: ignored working evidence pointer
`.krn/runs/claude-lead-20261021/consolidation/synthesis-20261022.md`]**
The three lenses found that most current queue failures are intra-repository,
not caused by the split. Literal test lists conflicted in 13 of 23 GLOBAL
runs, export-pin work produced 30 commits in three days, and Product
forwarded to installed GLOBAL revision `947746c`, then 55 commits behind
main. Seven open branches would each need `package.json` rework if N11 test
discovery were done first. The ledger also contained 1,449
`Change-contract:` trailers, while hook-trust hashes, `config.toml` paths,
and path-anchored lessons made mid-plan consolidation costly. These are
observations from the synthesis, not new measurements in this ADR.

**[POLICY]** The target is one repository with Product as its home. The
GLOBAL harness (skills, `AGENTS.md`, hooks, and installer) becomes a package
that is installed only from a sealed release. Moving code before the active
plan's qualification and tracker cutover would add one-way-door work.

## Decision

[POLICY] Keep code in its current repository for now. Fix the identified
friction in place: N10 export pin at ship; N11 test discovery after the
in-flight branches merge; N12 gate queue; Product merges through `krn ship`,
with `pr-preflight` as a pre-merge step and `pdeliver.sh` retired;
decide one Node line for both repositories (open decision); complete the
P-052 caller inventory. This does not authorize moving code between
repositories.

[POLICY] The forwarder in Product `src/cli/main.ts` exits when the complete
P-052 caller inventory shows no active caller depends on it. The inventory
must disposition each forwarded command as a Product-owned implementation,
a sealed GLOBAL package interface, or deliberate retirement; update KRN-06
with the same change.

The P-052 inventory must first assign a disposition to any active caller of
`krn task` or the Paperclip gateway. Delete that code, rather than migrate
it into the consolidated package or repository, only when the inventory
confirms it has no active caller.

[POLICY] Measure the trigger over the first 10 PRs merged after N10, N11,
and N12 land. Start consolidation when any condition holds over that sample:
more than 30% of outcomes touch both repositories; repo-boundary work
exceeds two lead-hours per PR; or F3 shows that `delegate` or `review` needs
GLOBAL internals beyond the seam. Schedule consolidation after F2
qualification and before tracker cutover, with all branches merged or
archived.

[POLICY] When triggered, the operator's one-way-door decisions are: re-seal
from the new source, `krn install apply`, hook re-trust, rewrite of
`config.toml` paths, and the history import/squash choice. This ADR records
no authority to perform those actions.

## Consequences

**[POLICY]** Product remains the eventual repository home, and the harness
remains a package boundary until a measured trigger fires. The in-place
changes address current delivery friction without an early code move. The
explicit forwarder exit and dead-code disposition prevent the temporary
seam and obsolete tracker/gateway from becoming part of the target by
default.

## Provenance

**[POLICY]** On 2026-10-22 the operator gave this final decision verbatim:
“tak, akceptuję kierunek konsolidacji — napierdalaj dalej”. It followed the
lead's synthesis of three independent Opus 5.5 lenses: internal cost,
external landscape, and devil's advocate.

**[DOC: ignored working evidence pointer `.krn/runs/claude-docs-consolidation-20261022/synthesis.md`]**
The task-run synthesis is the content source. Its full record is the ignored
working evidence pointer cited under Context. The LON-319 plan records the
sequencing for F2, F3, and tracker cutover.

**[DOC]** [P-052](../program/proposals.md)
owns the caller inventory; this ADR fixes the repository target and trigger.
