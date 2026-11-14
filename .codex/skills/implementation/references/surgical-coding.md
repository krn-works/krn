# Surgical Coding

## Avoid

- Changing nearby formatting because the file is open.
- Introducing a reusable abstraction for one caller.
- Replacing local conventions with preferred conventions.
- Adding broad error handling without a real caller path.
- Splitting work by layer instead of by observable behavior.
- Calling code inspection "verified" when the behavior needs runtime proof.

## Prefer

- One vertical behavior at a time.
- Existing helpers, test patterns, and command scripts.
- Small interfaces with meaningful implementation behind them.
- Explicit acceptance criteria before edits.
- Narrow verification after each meaningful change.

## Dependency Rule

Before adding a dependency, verify:

- the repo does not already have a suitable library,
- the new dependency is maintained and appropriate for the runtime,
- the user did not ask for no new production dependencies,
- the lockfile and install command are updated and verified.
