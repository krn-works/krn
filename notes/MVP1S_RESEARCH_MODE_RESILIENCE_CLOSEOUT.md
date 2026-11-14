# 2026-05-25 — MVP-1S Research-mode Resilience and Operator UX Closeout

## Goal

Close the MVP-1S research-mode resilience line end-to-end: required SearXNG for research discovery in `--research` mode, deterministic operator recovery, reachable/reachable-path validation, and local runbook alignment.

## Scope

Docs-only closeout. No app code changes in this slice.

## Findings by slice

- **S.0 design decision:** accepted. Research-mode discovery requires SearXNG; static discovery is only an explicit override.
- **S.1 provider resolution:** accepted. `--research --provider auto` resolves to SearXNG only for provider auto-resolution; no silent static fallback. Static remains explicit via `--provider static --candidate-url`.
- **S.2 health:** accepted. `krn-search health --research` exists; unreachable SearXNG exits non-zero and surfaces a required-searxng failure path. `--json` marks overall fail, while `--searxng-url` is supported and takes precedence over `SEARXNG_URL`.
- **S.3 dogfood:** accepted as `ACCEPT_MVP1S3_OPERATOR_UX`. Unreachable UX is clear and actionable before fetch; recovery points to `health --research`, and unreachable cases produce no run/session artifacts on provider-resolution failure.
- **S.4:** reached `NEEDS_FIX` because a stable, queryable local endpoint was not available in initial attempts.
- **S.4a:** accepted as `ACCEPT_REACHABLE_SEARXNG_PATH`. A known-good local startup path was validated and reachable `--research` execution was confirmed with real artifacts and provider=searxng.

## Final accepted capability

- SearXNG is required for research-mode discovery, and no silent fallback to static discovery exists in that path.
- SearXNG is not required for every command.
- `health --research` provides the operator preflight expected by S.1 recovery loops, with clear fail/ok outcomes.
- Static provider remains explicitly for known URL/manual/test overrides only.
- Runtime constraints remain unchanged: no public/native web fallback, no LLM-generated URL candidates, no browser automation, no schema changes, no provider refactors, and no new dependencies in MVP-1S.

## Remaining limitations

- SearXNG startup remains environment-sensitive; local runbook assumes Docker and image compatibility.
- JSON output shape from reachable local endpoint depends on container/readiness timing; operators should use health polling/readiness checks before search.
- S.4a command set is known-good for this host/image; drift in image tag may require periodic revalidation.

## Deferred candidates

- S.5a/6: optional hardening of readiness probes and startup checks (retries/backoff, timeout defaults, cleanup automation).
- Optional packaging of runbook as a script/targeted local target for non-docker-capable hosts.
- Optional monitoring hook for recurring SearXNG startup regression.

## Recommended next phase

- Move into operator-hardening follow-ups on local research startup reliability and operator docs quality (e.g., readiness, cleanup, and version-specific notes), while preserving current S.1–S.4a behavior guarantees.
- Continue monitoring for new blockers before any provider path or health logic refactor.

## Decision

**ACCEPT_MVP1S_RESEARCH_MODE_RESILIENCE**

