---
name: debug
description: Disciplined debugging for bugs, stack traces, failing tests, runtime failures, broken UI flows, performance regressions, flaky behavior, or user requests like "debug", "diagnose", "sprawdz", "napraw blad", "why is this broken". Use to reproduce, isolate, fix, and regression-test before proposing conclusions.
---

# Debug

Debug by building a feedback loop first. A hypothesis without a reproducible signal is usually wasted motion.

## Workflow

1. **Capture the exact symptom.** Preserve the user's error text, URL, command, screenshot detail, or failing behavior. Do not broaden the bug.
2. **Build a loop.** Prefer, in order:
   - failing test at the real behavior seam,
   - CLI command with fixture input,
   - HTTP/curl check against a running service,
   - Playwright or browser check for UI,
   - replayed payload, HAR, log, or trace,
   - minimal harness,
   - structured human-in-the-loop script when manual action is unavoidable.
3. **Prove reproduction.** Run the loop and verify it produces the same symptom. If non-deterministic, raise the repro rate with repetition, stress, fixed seeds, or narrower timing.
4. **Rank hypotheses.** List 3-5 falsifiable hypotheses. Each must predict what observation would confirm or disprove it.
5. **Instrument surgically.** Probe one variable at a time. Tag temporary logs with a unique marker like `[DEBUG-a4f2]`.
6. **Fix at the cause.** Prefer the smallest change that removes the cause, not a symptom mask.
7. **Lock the regression.** Add or update a test if there is a correct seam. If no seam exists, state that as an architecture finding.
8. **Clean up.** Remove debug logs, throwaway harnesses, and temporary scripts before completion.

## Stop Conditions

Stop and ask for the missing artifact only after you tried to build a loop and cannot. Report exactly what was attempted and what access or artifact would unblock the next step.

## Completion Bar

Do not claim the bug is fixed until:

- the original loop no longer reproduces,
- the regression test or equivalent proof passes,
- temporary instrumentation is removed,
- the final explanation names the actual cause and the proof.

Read `references/debug-loop.md` for examples of good loops.
