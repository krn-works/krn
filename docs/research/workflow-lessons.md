# Workflow lessons

Status: `accepted`. Owner: repository lifecycle writer. Consumer: the lead at outcome bind and the canonical change-contract checker. Verified: 2026-10-20.

Record reusable repository lessons with observed evidence and a real enforcing gate; keep outcome-specific logs in their owned run artifacts. Recall matching lessons before changing their paths, and bind the enforcing test in the commit's executable change contract. Retire a row when its gate is removed, or supersede it with a stronger observed lesson; do not copy unrelated global history. This page remains repository truth until explicitly superseded.

| Lesson | Evidence | Enforced by | Occurrences | Falsifier | Trigger | Status |
|---|---|---|---|---|---|---|
| Guard the complete reachable alias graph of a wrapped API, including reflected descriptors, and retain honest callback and static semantics. | LON-308 candidate `562cc300a61f7f37a66c8ea4e092376ff20a4a6a` rejected `test.only` but accepted equivalent `it.only` and suite aliases; the parameterized public-wrapper observer failed by assertion on that unchanged candidate. | `test/isolation-registration-aliases.test.mjs` | | | path:scripts/isolation-gate.mjs | active |
