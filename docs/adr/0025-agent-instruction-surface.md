# 25. Agent instruction surface: one rule text, one route per job, skills as thin procedures

Date: 2026-11-19

## Status

Proposed.

- Extends ADR 0024 (three rule sources) and ADR 0019 (pack hygiene, decision 6). It does not reopen them: it measures where they stand and names what they missed.
- The number may move if a standards ADR merges first.

## Context

Measured at `1cfd0601` (origin/main, 2026-11-19). Bytes come from `wc -c`. Hook output comes from running `node src/dispatch/main.ts <event>` with a real payload. The lane brief comes from `krn lane brief --task t-00kv6qn`. The history window is the last 300 first-parent merges (2026-11-16 to 2026-11-19), and the repository squashes with `squash_merge_commit_message: PR_BODY`, so each squash body is the PR body.

### Surface map

| Moment | Item | Bytes |
|---|---|---|
| Every session, always | `AGENTS.md` (`CLAUDE.md` is a symlink) | 2,178 |
| | 6 skill descriptions (frontmatter) | 1,770 |
| | 4 subagent descriptions (`.claude/agents`) | 649 |
| | SessionStart (`src/context/restart.ts`): lane worktree without a handoff, up to the cap for a lead with a handoff (`fitEnvelope`, resume block at most 3,000) | 172 to 8,000 |
| Every edit | PreToolUse edit-standards, per file (measured on 3 files) | 337 to 695 |
| Lane, mandatory | `krn lane brief` prefix: 3 records, gates, precedent, 9 worker rules, closure line | 4,278 |
| | `.agents/skills/delivery-lead/lanes.md` ("First read") | 3,561 |
| | KRN-10 makes `docs/program/repository-workflow.md` binding for "an agent" | 8,446 |
| Lead, mandatory | KRN-09 `docs/program/lead-rules.md` | 6,904 |
| | KRN-10 `docs/program/repository-workflow.md` | 8,446 |
| | `delivery-lead` SKILL.md plus lanes.md | 9,383 |
| | `docs/program/plan.md` ("read the plan before planning", lead-rules.md:29) | 17,985 |
| On demand | architecture 5,049; delivery-handoff 2,363; delivery-retro 2,906; workstation 4,691 | 15,009 |
| | standards SKILL.md 1,872, plus `INDEX.md` 12,397 ("read it once") and `OWN-INDEX.md` 6,185 | 20,454 |
| | other `docs/program` files (fable-plan-brief, hardening-checklist, standards-enforcement); `CONTEXT.md` | 10,244 |
| Maintained twice, never loaded | `src/adopt/skills/*` (a copy of 4 skills plus an architecture variant) | 34,096 |

Totals: a lane starts with about 21.1 kB (about 5.3k tokens) before its task. A lead starts with 37.3 kB, or 55.3 kB with the plan. ADR 0024 set the target at 15 kB or less. The registered metric `lead-mandatory-bytes` (`spec/metrics.json`) sums the ceilings in `spec/context-budget.json`, which is 91,729 today. That sum includes on-demand files and ignores actual size, so shrinking a file never moves it. The budget is also a ceiling that only rises: `delivery-handoff` has a budget of 4,995 against 2,363 actual bytes.

What works: hooks come from one table (`src/dispatch/table.ts`). Edit-time standards are scoped and small. The session-start output is capped. Dead paths, npm scripts and top-level `krn` commands are tested (`test/rules/instruction-references.test.ts`).

### Contradictions and dead pointers

Fixed in this PR:

- `.agents/skills/architecture/SKILL.md:42` and `docs/program/repository-workflow.md:29` name a `typescript` skill. #1152 (6e42f17b) replaced it with `standards`. The reference test does not check skill names.
- `docs/program/repository-workflow.md:60` says the project skills carry KRN additions "until this repository installs the universal set". Since #1101 they are installer output and byte-identical; `test/adopt/drift.test.ts:236` asserts it.
- `.agents/records.json:162` (`r-tracker-owner`, tier reflex, audience all) says "a worker never edits, closes or deletes a tracker file". KRN-11 (`spec/rules.json:77`), `lanes.md:5` and `closureRule` (`src/cli/lane-brief.ts:62`) order the lane to close its own task. Both texts reach the lane in the same brief. The record's provenance cites "AGENTS.md KRN-11", which was amended later; the copy was not.
- `src/task/cli.ts:69` (`krn task --help`) says workers "do not mutate tracker state", which also contradicts KRN-11.

Open:

- **Restated rules are served, against a decision.** ADR 0019:77 says records that restate an AGENTS.md rule "are not served as text at the session or lane moment", and names `r-regression-layer`. The lane brief serves `[r-regression-layer]`, `[r-tracker-owner]` and `[r-one-writer]` as text, because `src/brain/worker-packet.ts` ranks by tier and has no restatement filter.
- **Retro writes into a generated file.** `.agents/skills/delivery-retro/SKILL.md:20,32` makes "a rule in `AGENTS.md`" the second-best outcome. `AGENTS.md:1` is generated from `spec/rules.json`, and `npm run rules` fails a hand edit. Only `repository-workflow.md:63` corrects this.
- **KRN-07 names an opt-in command as its check.** Its `enforcement.check` is `npm run gate` (`spec/rules.json:33`), while its rationale and `lead-rules.md:25` say `npm run gate` is opt-in and never a prerequisite.
- **KRN-10's audience does not match its text.** `spec/rules.json:66` gives the audience as `lead`, but the rendered text says "When an agent works" (`AGENTS.md:9`). Every lane is therefore bound to an 8.4 kB lead document.
- **The wrong architecture copy is global.** `src/brain/global-standards.ts:30,99` links `~/.claude/skills/architecture` to this checkout's KRN-specific copy for every repository on the host. That copy uses `node scripts/architecture/depth.ts` (:25), `src/core` and KRN-05 (:18, :38), and `.krn/runs/lead/...` (:28). The neutral `src/adopt/skills/architecture/SKILL.md` is installed by nothing: `CORE` in `src/adopt/skill-set.ts:12` omits it.
- **A session sees another tree's instructions.** A worktree subagent loads the main checkout's `CLAUDE.md` and project skills, not those of its own base. This session received KRN-15, which names `scripts/fix-churn.mjs`; both are absent at its base `1cfd0601` and exist only in the main checkout. It also received an `architecture` description that differs from `.agents/skills/architecture/SKILL.md:3` at its base.
- **The workstation skill is host policy.** `.agents/skills/workstation/SKILL.md:18` points to an `omarchy` skill that is not in the repository. The skill (pacman, yay, `~/.config/mise`, Bitwarden) is host policy filed as a project skill. Its 431-byte description, the largest, triggers on "writing a hook or script that runs a tool", which describes most KRN changes.
- **Rule references an agent cannot resolve.** `docs/program/plan.md:49` and ADR 0024:47-48,75 name a `krn-lead` skill that was renamed `delivery-lead`. `architecture/SKILL.md:18,38` cites KRN-05, which is test-enforced and therefore never rendered into `AGENTS.md`.
- **The top-level help is incomplete.** `src/cli/help.ts:22` lists `krn pr ship --title --body-file [--repo] [--force]`, but the skills rely on `--worktree`, `--drop`, `--detach` and `--base` (`src/ci/ship.ts:33`).

### Duplicates: one rule, several wordings

| Rule | Places | Disagreement |
|---|---|---|
| Lane closes its own task | `spec/rules.json:77`, `lanes.md:5`, `delivery-lead/SKILL.md:25`, `lane-brief.ts:62`, `records.json:162`, `task/cli.ts:69`, `repository-workflow.md:51` | Two said the opposite (fixed here) |
| Local check | `AGENTS.md:5` and `lead-rules.md:25` say `fast` once; `lanes.md:4` and `lead-rules.md:52` say before every commit; the packet adds `krn standards review`, `krn standards check` and `bin/krn hook stop --check` | One command or five |
| Lane cap | `AGENTS.md:12`, `delivery-lead/SKILL.md:19`, `lead-rules.md:43`; the source of truth is `src/cli/lane.ts:125` | Agree today; three edits per change |
| Bounded context | KRN-13, `delivery-lead/SKILL.md:13-19`, `r-bounded-context`, `architecture/SKILL.md:27` | Wording |
| Regression layer | KRN-14, `r-regression-layer`, `delivery-retro/SKILL.md:9`, `delivery-lead/SKILL.md:29` | Wording |
| One writer | `repository-workflow.md:37`, `lead-rules.md:22,43`, `r-one-writer` | Wording |
| Park a decision when unattended | `delivery-lead/SKILL.md:43`, `delivery-handoff/SKILL.md:20`, `lead-rules.md:27` | Wording |

Every skill edit also lands twice. In the window, `delivery-lead`, `delivery-retro` and `lanes.md` changed 4, 4 and 3 times, each time in both copies. Instruction files changed in 28 of 300 merges (9.3%); ADR 0024 aims for under 8%.

### Open paths: "fix a bug and ship it"

The instructions allow these routes:

- **Check locally:**
  - `npm run fast` once (`AGENTS.md:5`);
  - `fast` before every commit (`lanes.md:4`);
  - `test` for a wide change (`lanes.md:4`);
  - `related` on the touched tests (`delivery-lead/SKILL.md:26`);
  - `npm run gate`, opt-in (`lead-rules.md:25`), though KRN-07's metadata names it as the check;
  - `krn standards review`, `krn standards check` and `bin/krn hook stop --check` (brief);
  - the Stop hook runs anyway.
- **Where to work:**
  - the lead in its own worktree (`krn lane start --actor lead`);
  - a non-lead session in the checkout it started in, with no branch and no ship route named (`repository-workflow.md:27`);
  - a background lane through `krn lane brief`;
  - headless `krn lane run`;
  - a Codex worker (`lead-rules.md:25`);
  - a cloud thread that opens the PR through the GitHub API.
- **Body:** `krn pr body`; the template written by hand (`repository-workflow.md:31`); or anything, because `krn pr ship` accepts any `--body-file`.
- **Ship:**
  - `krn pr ship --drop` (lead);
  - `krn pr ship` (lane);
  - `--detach`;
  - `krn lane finish`;
  - `krn lane run` (ships itself);
  - an API-opened PR merged later.
- **Task record:** closed in the PR (KRN-11); a separate `chore(tasks): close <id> after #N` PR; or batched with `krn task publish`.
- **Conflict:** ship rebases on its own (`src/ci/ship.ts:33`); `lead-rules.md:45` gives a manual rebase with `--force-with-lease`; `delivery-lead/SKILL.md:27` says rerun with `--force` after exit 76.

What the 300 merges used:

- **Task-record PRs:** all 300 went through a squash PR. 83 (28%) touch only `tasks/`: 68 are `krn task publish` batches and 15 are closes or notes.
- **Bodies of the 217 code PRs:**
  - 68 (31%) are template-shaped; 45 of them carry the lane marker (`Lane: krn lane brief`).
  - 149 (69%) have no template headings. 99 of those are co-authored by Sonnet (the lane model) and 50 by Opus.
  - 56 bodies hold only trailers, and only 10 of the 149 state a verification.
- **Checks named in bodies:** `npm run fast` in 56, `hook stop --check` in 9, `standards review` in 6, `npm run gate` in 0.
- **Cloud-thread PRs:** 0.

The template rule has no check, and most PRs bypass it. `npm run gate`, the manual rebase and the cloud route are documented routes that nobody used.

### Skills against practice

- **One job per skill.**
  - `delivery-lead` carries both the lead loop and the lane rules, though lanes are a different audience.
  - `standards` wraps a query that the PreToolUse hook already makes at every edit.
  - `workstation` is host policy.
- **Progressive disclosure.**
  - `standards/INDEX.md` asks for 12.4 kB "once".
  - `lanes.md` and `depth.ts` are the good examples.
- **Executable over prose.**
  - `delivery-lead` step 5 is 780 bytes of prose around two commands.
  - `delivery-handoff` has the agent write a file by hand, although `krn state handoff` exists (`repository-workflow.md:62`).
- **Descriptions written for routing.**
  - `delivery-lead` fires on "starting a slice", which covers any build request, though non-lead sessions must skip it (`repository-workflow.md:27`).
  - `workstation` fires on most script work.
  - `standards` fires "at the start of an edit", which a hook already covers.
- **Checks over rules.** 5 of the 7 rendered rules (KRN-09, 10, 11, 13, 14) have enforcement `none, manual review`.

## Options

**A. Finish ADR 0024 as written.** Fold `lead-rules.md` and `repository-workflow.md` into `delivery-lead` and `AGENTS.md`, then drop KRN-09 and KRN-10 (t-zkar758, open and unclaimed; its 50-merge red-CI baseline is long met: 300 merges since 2026-11-16).

- Gain: about 15 kB off the lead's mandatory reading.
- Leaves untouched: copies in records and briefs, two copies of each skill, sessions reading the wrong tree, the template bypass and the open routes.
- Risk: it makes the largest skill larger.

**B. One rule text, one route per job, thin skills (recommended).**

- **Rule text.** `spec/rules.json` holds the only text of a KRN rule. A record that restates a rule names it (`rule: KRN-NN`) and is never served as text (ADR 0019:77). Prose cites ids and does not restate.
- **One route.** `krn pr ship` is the one merge route, and it refuses a body without the template sections. Prose drops routes nobody uses.
- **Skills.** Each skill has one source, `src/adopt/skills`, plus a repository overlay in `references/<repo>.md`. Lanes get their own skill. Host policy leaves the repository.
- **Freshness.** Sessions read their own tree, and the byte metric measures actual mandatory bytes.

**C. Hooks only.** `AGENTS.md` becomes a pointer, every rule becomes a PreToolUse or Stop check, and skills become command cards.

- Gain: the strongest enforcement.
- Cost: agents learn rules by refusal, one turn each. The Stop hook is already 2,149 lines with a 660 s timeout, against the latency budget in ADR 0022. Handoff and retro are procedures, not checks.

## Decision

Choose B, built on ADR 0024 and ADR 0019. The three sources stay: rules in `AGENTS.md` rendered from `spec/rules.json`, direction in `plan.md`, procedure in skills. B adds that nothing else restates a rule, that the routes collapse to one per job, and that every remaining rule gets a check before more prose.

## Migration plan, one PR each

0. This PR: the four fixes above, a regression test (`test/rules/lane-close-rule.test.ts`) and this record.
1. **Retro and references:** `delivery-retro`, in both copies, writes rules to "the repository's rule source (`AGENTS.md` or the file its header names)". `instruction-references.test.ts` also checks `` `<name>` skill `` against installed skills and `KRN-NN` against `spec/rules.json`.
2. **Packet filter:** `worker-packet.ts` drops records whose provenance names a KRN rule; the test checks a real `krn lane brief` output.
3. **One body:** `krn pr ship` refuses a body without `## Why`, `## What changed`, `## Verified` (at least one `command: verdict`) and `## Task` when the tracker is `krn`. The test uses a hand-written body.
4. **Global skills:** link the neutral architecture copy globally and move the KRN-only lines to `references/krn.md`. `workstation` moves to user scope.
5. **Lane skill:** `delivery-lane` holds `lanes.md` and the prose worker rules from `lane-brief.ts:19`. The brief names the skill, and `delivery-lead` stops carrying lane rules.
6. **ADR 0024 step 2** (t-zkar758): fold the two program docs, drop KRN-09 and KRN-10, and fix the `krn-lead` name in the same plan PR.
7. **Metric:** `lead-mandatory-bytes` sums actual bytes of `AGENTS.md`, `delivery-lead` and every file a MUST rule names. The budget test fails when an entry is more than 10% above actual.
8. **Freshness:** a SessionStart line in a worktree when the main checkout's `AGENTS.md`, `.agents/skills` or `spec/rules.json` differ from the worktree's base, and a `krn doctor` row for a main checkout with uncommitted changes to those files.

## ASAP

1. **The same lane brief gave opposite orders about the task record** (`.agents/records.json:162` against `spec/rules.json:77` and `src/cli/lane-brief.ts:62`). The text is fixed here. The cause, restated records being served (ADR 0019:77), is step 2.
2. **69% of merged code PRs (149 of 217) skip the template**, and only 10 of those state a verification. The rule exists at `repository-workflow.md:31` and `delivery-lead/SKILL.md:27`, but `src/ci/ship.ts:33` accepts any body. Step 3.
3. **Worktree sessions load the main checkout's `CLAUDE.md` and skills**, so a rule can name a file that is absent at the session's base (KRN-15 and `scripts/fix-churn.mjs` reached this session). Step 8, and the lead never edits instruction files in the main checkout.
4. **The KRN-only architecture skill is linked into every repository on the host** (`src/brain/global-standards.ts:30,99`), with KRN commands at `.agents/skills/architecture/SKILL.md:25`, while the neutral copy is installed nowhere (`src/adopt/skill-set.ts:12`). Step 4.
5. **Retro's second disposition edits a generated file** (`delivery-retro/SKILL.md:20,32` against `AGENTS.md:1`), which fails `npm run rules`. Step 1.

## Expected effect

- Template-shaped bodies reach at least 95% of code PRs over the 100 merges after step 3. Measure: the share of first-parent squash bodies with `^## Verified`.
- Lane briefs carry 0 records whose provenance names a KRN rule. Measure: grep the brief output for those record ids.
- Each skill edit touches one file, and instruction churn falls below 8% of merges over 14 days.
- Actual mandatory bytes for a lead reach 15 kB or less after step 6, and about 13 kB for a lane after step 5.

## Consequences

- `src/adopt/skills` becomes the only hand-edited skill source, and `.agents/skills` stays installer output.
- Prose loses the routes that nobody used: `npm run gate` as a step, the manual rebase recipe, and the hand-written handoff where `krn state handoff` exists.
- A PR whose body skips the template is refused before the push, so hand-written bodies need the four sections.

## Falsified if

- Red-CI or lane rework rises by more than 10 points over 50 PRs after step 3 or step 6. Then the body check or the fold costs more than it saves; revert that step.
- Lanes still open `lead-rules.md` or `repository-workflow.md` in their first 5 calls after step 5. Then the lane skill does not replace the program docs.
- The share of template-less bodies stays above 20% after step 3. Then bodies reach main by another route, and that route needs the check too.
