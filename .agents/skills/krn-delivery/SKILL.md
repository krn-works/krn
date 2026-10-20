---
name: krn-delivery
description: Deliver or resume one scoped implementation task in a KRN-adopted repository using its current task owner, repository proof, and authorized delivery path. Skip diagnosis-only, read-only review, and single mechanical edits.
---

# KRN delivery

Use this procedure for an explicit request to implement and deliver a bounded KRN task, or when a task needs a handoff or resumption. Native Codex owns its model/tool loop; this skill does not create a second runner, task store, memory store, acceptance authority, or permission source. For diagnosis, read-only review, or one mechanical edit, use the narrow task directly.

Read the current task and acceptance source from the adopted control plane, then the nearest `AGENTS.md`, relevant durable decision, and only the code and instructions needed for the task. Resolve conflicts in the repository's stated precedence. Establish the authorized outcome, repository root, assigned checkout, base and current head, dirty-file owners, and any prior approved effects from current readback; a plan or handoff alone is stale evidence. Keep one writer for the outcome and preserve unrelated work.

Use the repository's existing CLI and commands only when their current source supports them. In Product KRN, the pinned Node entry is `node src/cli/main.ts`; the installed `krn` may refer to GLOBAL. `start` creates or records a worktree, while `checkpoint` writes a mailbox request consumed by the foreman. Do not present either as implementation proof or a commit. The existing supervised live route is `KRN_LIVE=1 npm run live -- --repo <absolute-path> --job <id> --issue <id> [--revision <updatedAt>]`; use it only when the current task calls for that route, and do not add `--submit`. Do not invent commands or flags.

Make the smallest complete change within the accepted scope. Preserve the actual task's contracts and existing control-plane ownership. Select the cheapest check that could disprove the change, then run the required repository checks. Bind any declared `Change-contract:` to an existing executable check whose observed result supports the declaration; never fabricate a red-before result, readiness, acceptance, or clean state. Compare failures with the base before attributing them to the change.

Use the target repository's actual publication gates. In Product KRN, an authorized push and draft PR provide inputs to `scripts/pr-preflight.mjs`; the checker requires an existing PR number and its readback. Run it on that PR, and gate marking the PR ready or merging it on the actual command returning exit 0. In another adopted repository, use its provided checks instead of assuming the Product checker exists. When committing, put `Ticket:` and `Change-contract:` in the same contiguous Git trailer block; omit a trailer only when its value is genuinely unavailable or no contract applies. Follow the repository's PR, review, CI, merge-readback, and branch/worktree-disposition owners. Reuse recorded authority without asking again for each covered effect. Stop at a changed scope, missing authority or capability, or failed required check; retain the failure and report one next lawful action. Roll back only task-owned work under recorded authority.

Report the task and source of acceptance, repository/base/head, dirty ownership, actual change, commands and exit results, proof limits and failures, and the next action. A completed procedure or successful skill selection does not itself mean the task was accepted or delivered.
