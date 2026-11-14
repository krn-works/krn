# ADR Format

ADRs live in `docs/adr/` unless a context-local ADR directory already exists.

Use sequential numbering:

```text
docs/adr/0001-short-slug.md
docs/adr/0002-short-slug.md
```

## Minimal Template

```md
# <Short Decision Title>

<One to three sentences: context, decision, and why.>
```

## Optional Additions

Only add sections when they carry real value:

- `Status: accepted`
- `Considered options`
- `Consequences`
- `Supersedes ADR-000N`

## ADR Bar

Create or offer an ADR only when:

1. the decision is hard to reverse,
2. a future maintainer would wonder why,
3. there were plausible alternatives.

Skip ADRs for obvious choices, local implementation details, reversible preferences, and decisions already obvious from code or tests.
