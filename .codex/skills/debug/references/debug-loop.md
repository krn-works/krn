# Debug Loop Examples

## Good Loops

- Bug report has a stack trace from a CLI: create a fixture input and run the CLI command until the exact stack trace appears.
- Checkout UI fails after shipping selection: create a cart, open checkout with Playwright, click the real shipping control, assert on the exact broken state.
- Generated HTML misses content: run the generator against a fixed source fixture and diff the output against expected HTML.
- Flaky race appears rarely: run the action 100 times with fixed seed and parallel stress until the repro rate is high enough to inspect.

## Bad Loops

- Reading code and guessing.
- Running the full test suite when only one narrow behavior is relevant.
- Asserting "does not crash" when the user reported wrong output.
- Adding broad logs without a falsifiable hypothesis.
- Fixing before proving reproduction.

## Minimal Hypothesis Format

```text
Hypothesis 1: If <cause>, then <probe> will show <observation>.
Hypothesis 2: If <cause>, then changing <one variable> will make <symptom> disappear.
```
