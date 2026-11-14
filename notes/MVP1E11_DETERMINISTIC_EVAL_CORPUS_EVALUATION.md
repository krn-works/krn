# MVP-1E.11 Deterministic Eval Corpus Evaluation

## Baseline

`dd5b8ebe13f3a54c77606b7e14d3265171e6b098` — fix: align eval-corpus cli contract

## Implementation commits

- `c4fb7470a7eec0231ef44822a8ef23a119cca479` — feat: add deterministic eval corpus
- `dd5b8ebe13f3a54c77606b7e14d3265171e6b098` — fix: align eval-corpus cli contract

## Purpose

Evaluate the `eval-corpus` capability which provides a deterministic, network-free way to verify the end-to-end search pipeline against a representative set of scenarios.

## Scope

- `search_tool/eval_corpus.py` — Core runner with mock-based scenario execution.
- `search_tool/run.py` — Refactored to break circular dependencies between CLI and search logic.
- `search_tool/cli.py` — `eval-corpus` subcommand added.
- `tests/fixtures/search_corpus/basic.json` — 11 deterministic scenarios.
- `tests/test_eval_corpus.py` — Unit and integration tests for the runner.

## Acceptance verdict

**ACCEPT_MVP1E11**

## What was implemented

- `eval-corpus` CLI command with `--work-dir` support.
- JSON-based scenario definition schema (v0.1).
- 11 deterministic scenarios covering happy path, duplicates, blocked URLs, provider errors, and redaction.
- Refactored `run.py` to move `EvidenceWriteResult` and `_quality_score` to `search.py`, allowing `run.py` to be imported by `eval_corpus.py` without circularity.
- Manifest hardening: blacklist-based secret redaction in YAML frontmatter.
- Network and DNS isolation via deep mocking in the runner.
- Artifact isolation: artifacts are written to temporary or user-specified directories.

## What was not implemented

- No live SearXNG required for the deterministic corpus.
- No new dependencies added to `pyproject.toml`.
- No changes to existing evidence or manifest schemas (stable v0.1).
- No synthesis or LLM-based evaluation.

## Eval corpus contract verification

| Check | Status | Evidence |
|---|---|---|
| search_tool/eval_corpus.py exists | PASS | File present in `search_tool/` |
| basic.json fixture exists | PASS | `tests/fixtures/search_corpus/basic.json` |
| schema_version 0.1 | PASS | `basic.json` line 2 |
| 11 scenarios defined | PASS | `basic.json` contains 11 entries |
| stable scenario IDs | PASS | IDs like `safe_single`, `duplicate_results` |
| no real secrets | PASS | Verified by inspection (fake secrets only) |
| deterministic mode is default | PASS | `eval_corpus.py` mocks everything |

## CLI contract verification

| Check | Status | Evidence |
|---|---|---|
| eval-corpus command exists | PASS | `cli.py` line 124 |
| --work-dir exists | PASS | `cli.py` line 126 |
| stdout JSON-only | PASS | `cli.py` line 164 |
| stdout parses with json.tool | PASS | Verified in verification step |
| stderr compact summary | PASS | `cli.py` line 154 |
| exit 0 success | PASS | Verified with `basic.json` |
| exit 1 failure/invalid input | PASS | Verified in `tests/test_eval_corpus.py` |

## Artifact isolation verification

| Check | Status | Evidence |
|---|---|---|
| work_dir controls artifacts | PASS | `eval_corpus.py` line 133 |
| default temp dir behavior safe | PASS | `eval_corpus.py` line 137 |
| no repo artifacts tracked | PASS | `git status` clean after run |
| no generated evidence committed | PASS | `.gitignore` covers `evidence/` |

## Network/DNS isolation verification

| Check | Status | Evidence |
|---|---|---|
| no live HTTP | PASS | `eval_corpus.py` mocks `fetch_url` |
| no real DNS | PASS | `eval_corpus.py` mocks `socket.getaddrinfo` |
| all fetch responses mocked | PASS | `eval_corpus.py` line 147 |

## Secret redaction verification

| Check | Status | Evidence |
|---|---|---|
| secret blacklist exists | PASS | `search.py` line 131 |
| case-insensitive matching | PASS | `search.py` line 133 |
| provider credentials not leaked | PASS | `provider_redaction_check` scenario |
| raw fake secrets absent | PASS | `query_redaction_check` scenario |

## Refactor verification

| Check | Status | Evidence |
|---|---|---|
| run.py resolves circular dependency | PASS | `eval_corpus.py` imports `search_tool.run` |
| cli.py remains command boundary | PASS | `main()` dispatches to `_run_eval_corpus` |
| fetch-url still works | PASS | 420/420 tests pass |
| discover-query still works | PASS | 420/420 tests pass |

## Test coverage

| Category | Count | Status |
|---|---|---|
| Full pytest suite | 420/420 | PASS |
| Eval-corpus scenarios | 11/11 | PASS |
| JSON parse check | 1/1 | PASS |

## Known limitations

- Scenario IDs must be unique within a corpus file.
- Redaction is blacklist-based and best-effort.
- Multi-hop redirects are partially mocked (single hop follow in current mock).

## Decision

**ACCEPT_MVP1E11**

The deterministic evaluation corpus provides a robust safety net for the search pipeline. It ensures that regressions in deduplication, policy checking, or manifest generation are caught immediately without requiring expensive or flaky integration tests.

## Next recommended task

MVP-1E.12 — Generate and evaluate search pipeline evaluation report. Use the new corpus to document current pipeline performance and identify any remaining edge cases before final MVP-1E closure.
