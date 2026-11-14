# MVP-1E Reopen and Workflow Acceleration

**Baseline:** `45fd3b69be26db64e7febc536777395bf966ac3d`
**Date:** 2026-05-10
**Scope:** Documentation and Claude Code workflow scaffolding only. No runtime source changes. No new dependencies. No implementation.

## Baseline

- HEAD: `45fd3b69be26db64e7febc536777395bf966ac3d` — docs: design query discovery layer
- Working tree: clean
- Tests: 231/231 passing
- CLI: `fetch-url` and `fetch-list` with `--refresh` and `--follow-redirects`
- Evidence schema: v0.1 stable
- Manifest schema: v0.1 stable
- All 7 dependency entries verified

## Why the spike is reopened

The MVP-1D design memo concluded that the spike should stop and lessons should be ported to krn-ai-os. That recommendation was correct at the time — the ingestion primitive was complete and query discovery required krn-ai-os decisions.

Since then:

1. krn-search is the right implementation home for the controlled search/ingestion tool. krn-ai-os will consume the capability later, but implementing the tool in krn-search keeps the boundary clean and lets us test behavior independently.
2. The discovery layer is a thin URL-producing interface that sits above the existing `fetch-list` pipeline. It does not require krn-ai-os architecture decisions — it only requires choosing a search backend and implementing the contract defined in the MVP-1D memo.
3. The spike's constraint system (handoff docs, agent protocol, test-first workflow) has proven effective at keeping scope narrow and preventing framework creep. Adding Claude Code workflow scaffolding accelerates future development without changing the constraint model.

## What changes from MVP-1D

- Spike is explicitly reopened for query discovery prototype
- Claude Code project skills added for workflow acceleration
- Query discovery implementation is now allowed through ACTIVE_TASK.md-scoped tasks
- No implementation in this task — this is scaffolding only

## What remains unchanged

- Ingestion layer (fetch-url, fetch-list, redirect following) is stable and unchanged
- Evidence schema v0.1 is unchanged
- Manifest schema v0.1 is unchanged
- URL policy is unchanged
- Cache semantics are unchanged
- Security posture is unchanged
- No browser automation
- No SQLite
- No agent frameworks
- No synthesis
- No MCP server
- No frontend

## Operating model

- All implementation work is scoped through ACTIVE_TASK.md
- Tasks follow the chain: design → implement → test → review → evaluate → next
- Project skills provide reusable workflow instructions for Claude Code
- No work proceeds without reading the current ACTIVE_TASK.md
- CLAUDE.md stays concise — procedural workflow lives in skills
- Non-goals are enforced by ACTIVE_TASK.md scope, not by memory

## Claude Code workflow scaffolding

Four project skills are added under `.claude/skills/`:

| Skill | Purpose | When to use |
|---|---|---|
| `krn-search-next-task` | Prepare next task prompt from current repo state | At the start of a new session or when phase is complete |
| `krn-search-implementation` | Execute a small implementation task | When ACTIVE_TASK.md has an implementation-scoped task |
| `krn-search-review` | Review local changes before push | Before pushing or at the end of an implementation session |
| `krn-search-acceptance` | Create acceptance/evaluation docs after implementation | When an implementation phase is ready for evaluation |

Skills are version-controlled project files, committed into the repo. They are discovered by Claude Code through the `.claude/skills/` directory structure.

## Skills to add

### krn-search-next-task

Prepares the next task prompt. Reads all handoff docs, verifies HEAD, summarizes current phase, identifies contradictions, proposes next prompt. Does not edit files.

### krn-search-implementation

Executes a small implementation task. Reads only ACTIVE_TASK.md-specified files, implements smallest viable diff, adds tests, runs targeted then full test suite, preserves evidence schema unless explicitly allowed, commits only after tests pass.

### krn-search-review

Reviews local changes before push. Inspects git diff, verifies scope against ACTIVE_TASK.md, checks for source/schema/dependency drift, runs tests, identifies blockers vs polish.

### krn-search-acceptance

Creates acceptance/evaluation docs. Verifies baseline, runs full tests, evaluates scenario checklist, creates evaluation memo, updates project notes, commits docs-only.

## Subagents to add later

The following subagents are deferred until a concrete need exists. Skills are sufficient for the current workflow.

| Subagent | Purpose | Deferred because |
|---|---|---|
| `krn-security-reviewer` | Isolated security review of changes | No changes yet require separate security context |
| `krn-test-reviewer` | Test coverage and quality review | 231 tests are sufficient for current scope |
| `krn-docs-reviewer` | Documentation consistency review | Docs changes are small and skills handle workflow |

Subagents are useful for isolated context review, but adding too many up front is premature. When a specific review need arises that benefits from a separate context window, the subagent should be created then.

## Hooks decision

Hooks are deferred until a specific enforcement need exists.

Rationale: Hooks run code with local credentials. Adding hooks before a concrete enforcement need risks unintended side effects. The current workflow is enforced through ACTIVE_TASK.md scope and skill instructions. When a pattern emerges that would benefit from automatic enforcement (e.g., blocking commits that don't pass tests, preventing pushes to main), a hook should be added for that specific case.

## Chained task plan

MVP-1E is structured as a chain of small, independently testable tasks:

| Task | Scope | Type | Depends on |
|---|---|---|---|
| MVP-1E.0 | Reopen spike + workflow scaffolding | Docs/config | MVP-1D complete |
| MVP-1E.1 | Discovery contract/types (no network provider) | Code + tests | MVP-1E.0 |
| MVP-1E.2 | Discovery backend interface + one provider | Code + tests | MVP-1E.1 |
| MVP-1E.3 | `search-query` CLI command | Code + tests | MVP-1E.2 |
| MVP-1E.4 | Evaluation | Docs | MVP-1E.3 |

Each task is scoped in ACTIVE_TASK.md before work begins. Tasks do not overlap.

## MVP-1E roadmap

### Phase 1: Scaffolding (this task)

- Reopen spike with decision memo
- Add project skills for workflow acceleration
- Update all project docs

### Phase 2: Discovery types

- Define `DiscoveryResult` type (candidate URLs, titles, snippets, metadata)
- Define discovery backend interface (protocol or ABC)
- No network provider — types and validation only
- Tests for type validation, URL policy integration, deduplication

### Phase 3: Backend integration

- Implement one discovery backend (exact backend TBD)
- Backend produces `DiscoveryResult` matching the contract
- URLs pass through url_policy before returning
- Tests with mocked backend responses

### Phase 4: CLI

- Add `search-query` command that chains discovery → fetch-list
- Discovery produces URL list → fetch-list produces evidence set
- No new evidence schema changes
- Tests with mocked discovery

### Phase 5: Evaluation

- Run evaluation scenarios from MVP-1D memo
- Accept or reject discovery prototype
- Update project docs

## Non-goals

- No query search implementation in this task
- No `search-query` CLI command in this task
- No SearXNG implementation in this task
- No Crawl4AI
- No browser automation
- No SQLite
- No runtime dependencies
- No source code changes in this task
- No evidence schema changes
- No fetch-list manifest schema changes
- No hooks
- No MCP config
- No global user skills under `~/.claude`
- No generated evidence/cache/tmp files
- No synthesis
- No agent frameworks
- No frontend

## Acceptance criteria

- [x] Reopen decision memo written with rationale and scope
- [x] Four project skills created under `.claude/skills/`
- [x] CLAUDE.md updated for MVP-1E phase
- [x] PROJECT_STATE.md updated
- [x] ACTIVE_TASK.md updated
- [x] EXPERIMENT_LOG.md updated
- [x] DECISION_CANDIDATES.md updated
- [x] 231/231 tests pass (no source changed)
- [x] No runtime source changes
- [x] No dependencies added
- [x] No pyproject.toml changes
- [x] No hooks created
- [x] No MCP config created
- [x] Docs-only commit

## Impact on krn-ai-os

krn-search remains the implementation home for the controlled search/ingestion tool. krn-ai-os will consume the capability later as a Python library or CLI tool.

What krn-ai-os gets from this reopen:
1. A working `search-query` command (after MVP-1E phases 2-4)
2. A verified discovery layer that produces policy-checked URLs
3. The same evidence pack / manifest contracts — no new schemas to learn
4. All the existing ingestion guarantees (security, failure honesty, caching)

What krn-ai-os still needs to decide:
1. Which discovery backend to use in production (SearXNG, Brave, Google, etc.)
2. Privacy policy for query handling
3. Synthesis architecture (how to merge evidence packs into answers)
4. Integration pattern (library import, CLI subprocess, daemon)
5. Result count and latency budget

## Recommended next prompt

```
MVP-1E.1 — implement discovery contract/types

Define the DiscoveryResult type and discovery backend interface
without implementing a network provider. Types only, with tests.

Use the krn-search-implementation skill.
```
