---
name: smoketest-lessons
description: Lessons from smoketests and CI gate implementation — things that broke and how to fix them
metadata:
  type: feedback
---

## Python command on this system

**Rule:** Before running project Python commands, resolve the interpreter: `.venv/bin/python` > `python3` > `python`. Never switch mid-task.

**Why:** This WSL2/Debian system has no `python` binary. `python3` exists but lacks the editable install / dev deps. `.venv/bin/python` has `search_tool` installed via `pip install -e .[dev]`. Using `python` fails silently with empty output that breaks later JSON parse steps.

**How to apply:** Use `.venv/bin/activate` or `.venv/bin/python` for all local project commands (tests, eval-corpus, health, search-query). CI uses `python` from `actions/setup-python` and is correct there.

---

## Research-mode preflight smoke must be preflight-only

**Rule:** Research-mode CI smoke must use a path that fails BEFORE any network call. Invalid profile or missing required args are preflight errors.

**Why:** The `search-query` command always fetches candidate URLs. `--provider static` with a valid profile and candidate URL hits live docs.python.org or example.com. The research-mode preflight structure check was hitting live network until merged into the error JSON step.

**How to apply:** Use `--profile nope` (or any invalid profile) to trigger preflight error. The error JSON still contains `research_mode` with `expanded_defaults` and `effective_values`, so the same output validates both the error state AND the preflight structure.

---

## Error JSON: stderr ≠ stdout

**Rule:** CLI error messages go to stderr, structured JSON goes to stdout. Always redirect stdout to file and stderr separately.

**Why:** Using `> file 2>&1` merges both streams into one file. The file starts with the error text (stderr), then JSON (stdout). `json.tool` fails on the first line because it's not JSON.

**How to apply:** Use `> /tmp/output.json 2>/tmp/stderr.txt`. For error smoke tests, stdout is still valid JSON even when CLI exits non-zero.

---

## effective_values vs expanded_defaults distinction

**Rule:** `research_mode.expanded_defaults` has the preset defaults. `research_mode.effective_values` has what the user actually provided (may be invalid).

**Why:** When `--profile nope` is passed, `expanded_defaults.profile` is `"official-docs"` (the preset) but `effective_values.profile` is `"nope"` (user override). Asserting `effective_values.profile == "official-docs"` will fail for error paths.

**How to apply:** In CI assertions, only check `effective_values.profile` against the default when the user DID provide a valid profile. For error smoke tests, assert `effective_values.profile` equals the invalid value the user passed.

---

## `.gitignore` needs `*.egg-info/`

**Rule:** Always add `*.egg-info/` to `.gitignore` after `pip install -e .`.

**Why:** `pip install -e .` creates `krn_search_lab.egg-info/` (or whatever the package name is). This is an untracked build artifact that looks like a problem but isn't committed. Without `.gitignore`, `git status` shows it as untracked noise.

**How to apply:** After initial `pip install -e .`, check `git status --short` for untracked `*-egg-info/` directories and add them to `.gitignore`.

---

## SearXNG containers may be running but unreachable

**Rule:** When testing local SearXNG, verify port mapping AND endpoint, don't assume container = accessible.

**Why:** Multiple SearXNG containers can exist with `8080/tcp` but only container-port binding (no `0.0.0.0:XXXX->8080`). The host:8080 hit may be a reverse proxy returning 404, not SearXNG. Also verify the correct endpoint: `POST /search` with `q=...&format=json`.

**How to apply:** After `docker run`, verify with `curl -v` to confirm port mapping. Check `docker ps` for host port mapping pattern `0.0.0.0:XXXX->8080`. If not mapped, the container is not reachable from host.

---

## Check for uncommitted drift before commit

**Rule:** After completing a task, run `git diff --stat` before staging to catch unintended changes.

**Why:** `.claude/settings.json` can change during a session (plugin reloads, skill installs) without being part of the task. Committing it introduces noise.

**How to apply:** Always `git diff --stat` before `git add`. If unexpected files appear, check if they're relevant. Revert with `git checkout -- <file>` if not.
