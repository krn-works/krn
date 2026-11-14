# Handoff: MVP-1R.2a Merged

## Merge status

- PR: `#23`
- URL: `https://github.com/korneliuszburian/krn-search/pull/23`
- State: `MERGED`
- Merge commit on `main`: `462e5135b61c0c4ca360c8ab258e5eae485175dd`
- CI (run #101): success

## What landed

- Mechanical source snippets added to `session-summary`.
- Evidence-pack fallback path safety fix:
  - absolute `evidence_path` rejected
  - traversal outside current `run_dir` rejected
  - candidates resolved only under `run_dir` / `run_dir/evidence`
- No schema changes, no dependency changes, no `search-query` behavior changes.

## Verification at merge point

- `pytest -q` -> `1052 passed`
- `python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json` -> `11/11`
- `git diff --check` -> clean

## Local repo state

- Current branch: `main`
- Local `main` includes merge commit `462e513`.
- Feature branch `mvp-1r2a-session-summary-snippets` removed.
