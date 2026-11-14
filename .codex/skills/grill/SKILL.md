---
name: grill
description: Stress-test plans, specs, architecture ideas, product flows, and ambiguous coding requests against the project's domain language, existing code, CONTEXT.md, and ADRs. Use before implementation when the user wants a plan challenged, terminology sharpened, assumptions resolved, or durable docs updated as decisions crystallize.
---

# Grill

Use this skill to turn a fuzzy plan into shared understanding. The output is not code first; it is sharper language, resolved decisions, and a smaller implementation surface.

## Workflow

1. **Load existing context.**
   - If `CONTEXT-MAP.md` exists, read it and identify the relevant context.
   - Else if root `CONTEXT.md` exists, read it.
   - Read relevant ADRs under `docs/adr/` or context-local `docs/adr/` when the plan touches architecture, persistence, integration, deployment, auth, or ownership boundaries.
   - If docs do not exist, proceed silently. Create them lazily only when a term or ADR is actually resolved.
2. **Check code before asking.** If a question can be answered by reading the repo, inspect the code instead of asking the user.
3. **Ask one question at a time.** Walk the decision tree branch by branch. Each question should include your recommended answer and why.
4. **Challenge language.** When the user uses vague, overloaded, or conflicting terms, propose one canonical term. If it conflicts with `CONTEXT.md`, call out the conflict directly.
5. **Stress with scenarios.** Use concrete examples that force boundary decisions, edge cases, lifecycle states, ownership, and failure modes into the open.
6. **Update docs inline.**
   - When a domain term is resolved, update the relevant `CONTEXT.md`.
   - When a durable architecture decision meets the ADR bar, offer to record it.
7. **Stop when implementation is obvious.** End with resolved terms, decisions, acceptance criteria, and recommended next skill: usually `$implementation`, `$debug`, or `$coding-system`.

## CONTEXT.md Discipline

`CONTEXT.md` is a glossary, not a spec. Keep it free of implementation details.

Use `references/context-format.md` when adding or editing terms.

Only add terms that are specific to the project's domain or operating model. Do not add generic programming terms.

## ADR Discipline

Offer an ADR only when all three are true:

- the decision is hard to reverse,
- the reason would be surprising without context,
- there was a real trade-off between plausible alternatives.

Use `references/adr-format.md` when creating ADRs.

## Question Shape

Use this shape:

```text
Question: <one concrete decision>
Recommendation: <your recommended answer>
Why: <code/doc evidence or design reasoning>
If we choose differently: <trade-off>
```

Ask one question and wait. Do not dump a giant questionnaire unless the user explicitly asks for it.
