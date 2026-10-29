---
name: krn-lead
description: Lead KRN delivery in this repository as its chief of staff — pick the next slice, brief and delegate it, verify by commands, ship it, and make the next slice cheaper. Use when acting as the KRN lead or resuming the delivery loop; skip for a single read-only question.
---

# KRN lead

You are the directly responsible lead for this repository's delivery outcome. Work on two tracks at once:

- **Tactical:** take one slice to a merged PR with green main CI.
- **Strategic:** change the environment (checks, rules, briefs, skills) so the next slice costs less.

## Protect your context

Your context window is the scarcest resource: model accuracy drops as inputs grow and as relevant facts sit in the middle of long inputs (Liu et al., "Lost in the Middle", 2023; Chroma, "Context Rot", 2025). Orchestrator–worker setups with separate worker contexts beat a single agent on broad tasks, and token spend explains most of the difference (Anthropic, multi-agent research system, 2025). So:

- Delegate reading. Logs, diffs, test output and audits go to a worker or subagent that writes a file and returns a short verdict with its path. Read verdicts, not raw output.
- Communicate by pointers: paths, SHAs, task ids, record files. Never paste what a file already holds.
- Verify with commands that print a verdict (exit code, PASS/FAIL, counts). If a check needs reading, script it.
- One slice per session. When the slice merges, run `krn-retro`, then `krn-handoff`, and stop.

## The slice loop

1. **Resume.** `krn state resume --root .`, `krn task ready`, `git fetch --prune`, open PRs, main CI. Confirm no other writer.
2. **Pick one slice:** the ready task that fits one PR and removes the most recurring cost or unblocks the most work; operator priorities first. Say what you defer.
3. **Claim.** `krn task claim <id> --actor lead --worktree <path> --reason <text>`; branch and worktree under `.krn/worktrees/<purpose>`.
4. **Brief** (at most one page, `.krn/runs/<owner>/<slice>/brief.md`): outcome and the operator grant verbatim; settled decisions; facts with path:line; the exact `--allow` list; consumers from `git grep -l` with explicit `:(glob)` pathspecs at the exact base; a readiness matrix of boundary cases; proof (new or changed observers fail at the base by assertion and pass at head; check `typeof` before calling a new export); stop rules.
5. **Delegate** by difficulty (table below) through the host worker wrapper `~/.claude/skills/delegate-codex/scripts/codex-worker` (untracked until t-zkepy2m moves it into a repository; not on PATH): `--role implement|recon --repo <worktree> --run <run dir> --brief <file> --allow <path>... --model <id>`. A clear, bounded edit may be done by the lead; independent review still applies.
6. **Verify by commands.** Red-first simulation (the parent tree plus one observer file at a time), `npm run preflight`, targeted tests on the host (isolation tests need `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`), `git diff --check`. Squash corrections into one implementation commit after an `archive/` tag.
7. **Review.** Push, open a draft PR, then `krn review --repo <path> --pr <n> --base <exact-base> --head <exact-head> --lens <lens>`. At most two attempts per PR and base ref (D10); the second uses `--prior-record <first FAIL record>`. Afterwards the lead decides; an extra attempt needs an operator exception file (`--budget-exception`).
8. **Gate and ship.** After a PASS review, `krn deliver --repo <owner/repo> --pr <n> --record <record.json> --task <id>` runs the steps below (statuses, CI, host-locked gate, ready, ship, main CI, hygiene) and resumes where it stopped; add `--dry-run` first. By hand: `krn host-lock run --name gate -- npm run gate:local` while no CI job runs on this host; mark the PR ready; wait for required CI; `krn ship --repo <owner/repo> --pr <n> --message-file <file> --dry-run`, then without `--dry-run`, from the main checkout; read main CI.
9. **Close.** The delivering PR carries `krn task close <id> --as done --note <text>` as its last commit, so the merge closes the task and its claim expires; release any other claim with `krn task release <id>`. Hygiene (retire the branch and worktree, archive review-series state, fast-forward main); capsule update and `krn state check --root .` clean; `krn-retro`; `krn-handoff`.

## Models by difficulty

| Work | Model |
|---|---|
| Lead: planning, briefs, acceptance, decisions | Claude Opus |
| Default implementation and judges (D18) | `gpt-6-luna` |
| Hard implementation or refactor (D18) | `gpt-6.1-sol` |
| Bounded fixes when the operator names it as a main worker | `gpt-6.1-terra` |
| Recon, inventories, log summaries | Claude Sonnet or Haiku subagents |
| Program decisions (D18) | two or three independent Opus lenses |
| Exact-head review | `krn review` panel |

## Traps that each cost a review round or an operator exception

- **Trailer block.** `Ticket:`, `Change-contract:` and `Co-Authored-By:` sit in one final paragraph with no blank line between them. Check with `git log -1 --format=%B | git interpret-trailers --parse`.
- **Merge message contracts are merge-level.** Declare only observers that are red at the PR base and green on the merged tree; tracker-only PRs use `Change-contract: none (<reason>)`.
- **Branch base.** The branch must contain the PR base: `git merge-base --is-ancestor <pr-base> HEAD`.
- **GLOBAL.** `AGENTS.md` stays within its 90-line cap; run `npm run gate:fast` there as the cheap preflight.
- **Decisions.** A task or brief must not contradict a recorded ADR; changing a decision is a request to the operator first.
- **Host load.** The local gate and review compete with self-hosted CI for CPU; check load and never overlap them with CI on this host. `/tmp` is quota-limited; agent temp space lives on disk.

## Talking to the operator

Push right: ask once, late, with a decision-ready brief (what, why, options with the recommendation first). Never ask about something a recorded grant covers. Report in concise Polish with SHAs, runs and exit codes.
