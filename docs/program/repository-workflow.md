# Repository workflow

This repository adopts KRN as a delivery layer above its harnesses. The same
role names apply across harnesses: lead, worker, and judge. Use role names for
people and agents; keep phase, slice, and date labels in task records.

The accepted request or native Goal records the current outcome, scope,
authority, and uncertainty. A native Goal is a continuation view of that
outcome, not durable repository truth. Repository `AGENTS.md` files own local
workflow and gates; trusted host settings and actual tool limits remain
host-owned. Select one procedure for a task. Hooks provide deterministic
interception rather than judgment or orchestration, and CI or host policy owns
publication and deployment checks.

Keep KRN-created repository state in ignored `.krn/worktrees/<branch>/`,
`.krn/runs/<owner>/`, `.krn/sources/`, or `.krn/tmp/` paths; host tool
configuration is exempt.

## Control plane and durable state

Use one control plane. Paperclip remains the source of task status and
acceptance until Product has an explicit project cutover under [ADR
0011](../adr/0011-krn-work-tracker.md); the target tracker design alone does
not perform that cutover. Do not mirror writes. After cutover, the selected KRN
tracker is the control plane. The lead or delivery loop owns its writes;
workers do not write task status. Task status or a worker handoff alone is not
acceptance. Global ADR 0007 governs acceptance and PR delivery; the lead loop
executes acceptance after required evidence and gates pass.

When a delivery-loop outcome uses a capsule, its state belongs at
`.krn/runs/delivery-loop/<outcome-id>/state.md`. `$delivery-loop` is its sole
writer; use `krn state check` to validate it and `krn state resume` to resume
from it. Durable repository decisions and context belong in `CONTEXT.md`,
`docs/adr/`, and `docs/research/`. The header of
`docs/research/workflow-lessons.md` defines how cross-run lessons are recorded,
recalled, and retired. Native Goals, transcripts, and personal memory are not
durable repository truth.

## Roles and delivery

- **Lead:** follows [lead rules](lead-rules.md), owns the outcome loop and
  control-plane updates, and coordinates scoped work.
- **Worker:** implements or investigates the assigned slice and returns its
  changes, evidence, and limits to the lead. A worker does not accept the
  outcome or write tracker state.
- **Judge:** independently reviews the requested standards or specification
  against the exact candidate head SHA. A PR merge requires required CI and
  successful independent `krn/judge-standards` and `krn/judge-spec` results on
  that same SHA; authors never judge their own work.

Use one writer per outcome at a time and transfer the writer role explicitly
before a mutating handoff. Parallel implementation uses isolated worktrees and
returns through one integrator; independent read-only work may run in parallel.
The `$delivery-loop` owns its capsule and terminal closeout. Reuse recorded
authority for the same outcome's commit, push, PR, and merge without repeating
per-step prompts.

## Proof and completion

Match proof to changed risk: add no tests for mechanical, documentation,
type-only, topology, or already-observed behavior-preserving work; use one
focused falsifier for a changed runtime contract, migration, authority
boundary, parser, or reproduced bug, and add more only for distinct
requirements and failure modes. Give each artifact a named consumer and
deletion or supersession trigger.
Progress and completion claims require observed evidence or readback. A
deterministic falsifier outranks model review; same-model self-assessment is not
proof, and new falsifiers must be shown failing first.

Use Conventional Commits for authored commits, PR titles, and squash subjects.

## Harness-surface contracts

For a repository that has `npm run changes:check`, a harness-surface commit
records `Change-contract: <check>:red->green` with its `Ticket:` trailer in the
same trailer block. The contract names an existing executable check. Changed
or new observers need observed before-state via `--before`; behavior-preserving
changes keep their existing checks green. Run `npm run changes:check` to verify
the declared predictions; it blocks unmet predictions and names the commit to
revert or repair.

At every terminal PR, `$delivery-loop` records each owned branch and worktree
as retired under recorded deletion authority after preserving needed evidence,
or retained with one owner, consumer, and removal trigger. A merged head branch
is retired locally and remotely and its worktree removed in the same closeout.
For a closed unmerged or superseded PR, retain a branch or worktree only while
a named successor or evidence consumer needs it; otherwise preserve needed
evidence and retire it under deletion authority. PR closure grants no deletion
authority. Do not delete another owner's ref or worktree, and leave none
unowned.
