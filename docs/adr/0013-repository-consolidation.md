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
main. Seven open branches would each need `package.json` rework if test
discovery were done first. The ledger also contained 1,449
`Change-contract:` trailers, while hook-trust hashes, `config.toml` paths,
and path-anchored lessons made mid-plan consolidation costly. These are
observations from the synthesis, not new measurements in this ADR.

**[POLICY]** The target is one repository with Product as its home; Global
folds into it when this ADR's measured trigger fires. The Global KRN
compatibility package (skills, `AGENTS.md`, hooks, and installer) is installed
only from a sealed release. Moving code before the active plan's worker
qualification and the measured consolidation trigger would add one-way-door
work.

## Decision

[POLICY] Keep code in its current repository for now. Fix the identified
friction in place: pin exports at ship; discover tests after the
in-flight branches merge; improve the gate queue; Global KRN's `krn ship`, reached
through Product's KRN-06 forwarder, performs merges; keep `pr-preflight` as a
pre-merge requirement and retire `pdeliver.sh`;
decide one Node line for both repositories (open decision); complete the
P-052 caller inventory. This does not authorize moving code between
repositories.

[POLICY] The forwarder in Product `src/cli/main.ts` exits when the complete
P-052 caller inventory shows no active caller depends on it. The inventory
must disposition each forwarded command as a Product-owned implementation,
a sealed GLOBAL package interface, or deliberate retirement; update KRN-06
with the same change.

The P-052 inventory must assign a disposition to active callers of the legacy
Git-ref `krn task` queue and Paperclip gateway. The tracker decision in ADR
0014 D8 selects a Git-backed in-repository successor; import existing records
before removing Paperclip everywhere, and add no new Paperclip dependencies.
Delete other legacy code only when the inventory confirms it has no active
caller.

[POLICY] Measure the trigger over the first 10 PRs merged after the export
pin, test-discovery, and gate-queue changes land. Start consolidation when
any condition holds over that sample:
more than 30% of outcomes touch both repositories; repo-boundary work
exceeds two lead-hours per PR; or Product delivery shows that `delegate` or `review` needs
GLOBAL internals beyond the seam. Schedule consolidation after worker
environment qualification and when the measured trigger fires, with all
branches merged or archived. Tracker import and Paperclip removal follow ADR
0014 D8; no per-project Paperclip cutover is required.

[POLICY] When triggered, the operator's one-way-door decisions are: re-seal
from the new source, `krn install apply`, hook re-trust, rewrite of
`config.toml` paths, and the history import/squash choice. This ADR records
no authority to perform those actions.

## Consequences

**[POLICY]** Product remains the eventual repository home, and the Global KRN
package remains a compatibility boundary until a measured trigger fires. The in-place
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
working evidence pointer cited under Context. The delivery plan records
worker qualification and delivery sequencing; tracker implementation,
import, and Paperclip removal follow ADR 0014 D8.

**[DOC]** [P-052](../program/proposals.md)
owns the caller inventory; this ADR fixes the repository target and trigger.
