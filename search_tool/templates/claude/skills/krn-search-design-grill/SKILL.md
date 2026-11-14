---
name: krn-search-design-grill
description: >
  Design grilling for krn-search architecture decisions and feature designs. Use for
  design-phase tasks like MVP-1Q.0, MVP-1R, or any task that requires architectural
  thinking before implementation. Reads existing docs and architecture before proposing
  anything new. Does NOT implement code — design output only. Use when the user says
  "design", "architecture", "propose", "evaluate approach", "what should we do about X",
  or any task that is explicitly docs/design-only in ACTIVE_TASK.md.
---

# krn-search-design-grill

Design-phase grilling for krn-search. Architecture decisions, feature designs, and technical proposals. No code.

## When to use

- Design tasks (MVP-1Q.0, MVP-1R, etc.)
- Architecture decisions
- Feature design before implementation
- Evaluating trade-offs between approaches

## When NOT to use

- Implementation tasks (use krn-search-implementation)
- Bug diagnosis (use krn-search-diagnose)
- Code review (use krn-search-review)

## Startup

Read these files in order before proposing anything:

1. `CLAUDE.md` — project identity, constraints, non-goals
2. `notes/PROJECT_STATE.md` — current state, recent work
3. `notes/ACTIVE_TASK.md` — current task scope

If any of these conflict with each other, stop and flag the conflict. Do not proceed with design work on top of inconsistent state.

## Process

### Step 1: Check existing architecture

Before proposing new design, check what already exists:

```bash
ls docs/architecture/
ls notes/
```

Read any relevant architecture docs and prior design memos. Do not propose something that already exists in `docs/architecture/` without acknowledging it.

### Step 2: Define the problem

State the problem clearly:
- What needs designing
- Why it matters (reference ACTIVE_TASK.md or user request)
- What constraints apply (from CLAUDE.md non-goals, accepted limitations, etc.)
- What existing architecture is relevant

### Step 3: Survey the codebase

Read only the source files relevant to the design. If ACTIVE_TASK.md lists specific files, read those. If not, explain which files you need to read and why before reading them.

Do not read the entire codebase. Target onboarding budget: under 5k tokens.

### Step 4: Propose design

Present the design as a structured document:
- Problem statement
- Constraints
- Proposed approach (with rationale)
- Alternatives considered (and why rejected)
- Risk analysis
- Staged implementation plan (if applicable)

### Step 5: Self-grill

Before presenting to the user, challenge your own design:
- Does it violate any CLAUDE.md non-goals?
- Does it conflict with existing architecture?
- Does it introduce new dependencies?
- Does it change evidence/manifest schema? (Should not, unless explicitly allowed)
- Can it be tested deterministically?
- What happens when it fails?

### Step 6: Update docs

Only after the design is clear and reviewed:
- Write design doc to `docs/architecture/` if architectural
- Write design memo to `notes/MVP*.md`
- Update `notes/ACTIVE_TASK.md` if task status changes

## Constraints

- Do not implement code. This skill produces design documents only.
- Do not skip reading existing architecture before proposing.
- Do not ask the user questions that the repo/docs can answer — find the answer yourself first.
- Do not proceed if CLAUDE.md conflicts with PROJECT_STATE.md or ACTIVE_TASK.md.
- Do not add dependencies in design (flag them as future considerations instead).
- Do not design features that are in the CLAUDE.md hard non-goals list.
