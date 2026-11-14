# Review Checklist

## Correctness

- Does the implementation satisfy the stated acceptance criteria?
- Are edge cases from real callers handled?
- Are async, lifecycle, cache, or concurrency assumptions valid?
- Does the change preserve existing public contracts?

## Tests And Proof

- Do tests exercise behavior through stable interfaces?
- Would tests fail if the user-visible behavior regressed?
- Is there runtime/rendered/remote proof where required?
- Are skipped tests or unverified environments called out?

## Maintainability

- Are modules deep enough to justify their interfaces?
- Did the change duplicate knowledge that should live in one place?
- Are names aligned with project vocabulary?
- Are unrelated refactors mixed into the diff?

## Security And Data

- Are credentials, tokens, PII, or secrets exposed?
- Could input validation, auth, permissions, or escaping regress?
- Could this cause data loss, duplicate writes, or irreversible side effects?
