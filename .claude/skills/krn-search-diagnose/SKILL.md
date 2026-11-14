---
name: krn-search-diagnose
description: >
  Diagnose bugs, bad search results, failed evals, failing tests, or weird diagnostics
  in the krn-search codebase. Use when tests fail, eval-corpus scenarios break, search
  results look wrong, discovery produces unexpected output, or any krn-search behavior
  needs debugging. Enforces a deterministic feedback loop before proposing fixes —
  no guessing, no speculative changes. Also use when the user says "debug", "diagnose",
  "investigate", "why does X fail", "broken test", "bad results", or reports unexpected
  krn-search behavior.
---

# krn-search-diagnose

Systematic diagnosis of krn-search issues.

## When to use

- Tests fail (pytest failures)
- eval-corpus scenarios break
- Search results look wrong (wrong URLs, bad evidence, missing content)
- Discovery produces unexpected output
- discovery-diagnostics.json has surprising entries
- Search-run manifests show unexpected behavior
- Compact summaries look off

## Process

### Phase 1: Reproduce deterministically

Before changing anything, reproduce the issue with a concrete command.

Preferred reproduction methods, in order:

1. **Focused pytest** — run the specific failing test file:
   ```bash
   if [ -x .venv/bin/python ]; then PYTHON_BIN=.venv/bin/python; else PYTHON_BIN=python3; fi
   $PYTHON_BIN -m pytest tests/test_<module>.py -v
   ```

2. **eval-corpus** — deterministic, no network:
   ```bash
   krn-search eval-corpus tests/fixtures/search_corpus/basic.json --work-dir "$(mktemp -d)"
   ```

3. **Static provider smoke** — with known URLs:
   ```bash
   krn-search search-query "<query>" --provider static --candidate-url <url> --work-dir "$(mktemp -d)"
   ```

4. **discovery-diagnostics.json inspection** — read the diagnostics file from a recent run

5. **search-run.json / compact summary inspection** — read manifest and summary files

If you cannot reproduce the issue deterministically, say so. Do not proceed to fixes based on speculation.

### Phase 2: Inspect diagnostics

Read the relevant artifacts before forming hypotheses:

- `discovery-diagnostics.json` — per-candidate discovery-stage accounting (rank, URL, title, snippet, source_engine, source_quality)
- Search-run manifest — query metadata, provider config, discovery summary, blocked candidates
- Fetch-list manifest — per-URL table, success/blocked/failed counts
- Compact evidence index — source table with quality scores
- Evidence packs — YAML frontmatter + extracted content
- Test output — pytest output, error messages, tracebacks

### Phase 3: Form hypotheses

Based on Phase 2 inspection, write down hypotheses before touching code.

Each hypothesis must state:
- What you observed
- What you expect instead
- Which module/function is likely responsible
- Why

Rank hypotheses by likelihood. Only investigate one at a time.

### Phase 4: Minimal fix

Make the smallest change that addresses the most likely hypothesis.

- Prefer editing existing code over adding new code
- Prefer one-line fixes over refactoring
- Do not refactor surrounding code while fixing a bug

### Phase 5: Verify

Run the reproduction command from Phase 1 again. The issue must be resolved.

Then run the full test suite:
```bash
if [ -x .venv/bin/python ]; then PYTHON_BIN=.venv/bin/python; else PYTHON_BIN=python3; fi
$PYTHON_BIN -m pytest -q
```

All tests must pass. If the fix breaks other tests, revert and form a new hypothesis.

### Phase 6: Regression test

Add a regression test that would have caught the original issue. If no testable seam exists (e.g., the issue is in CLI output formatting only), document why no regression test is practical.

### Phase 7: Review packet

Do not claim done without producing a review packet containing:
- Original issue description
- Reproduction command
- Hypothesis investigated
- Fix applied (files changed, diff summary)
- Regression test added (or documented reason none)
- Test results: N/N passing
- Any remaining concerns

## Constraints

- Do not propose fixes without a deterministic reproduction
- Do not refactor while fixing
- Do not skip the hypothesis step
- Do not claim done without a review packet
- Do not add dependencies
- Do not change evidence/manifest schema unless the issue is a schema bug itself
