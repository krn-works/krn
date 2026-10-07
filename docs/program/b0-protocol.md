# B0 — baseline protocol (arm A = today's method), 2026-10-07
Tasks (operator: "1 + 2 + LON, lead picks"):
- T1 krn-codex-skills: lessons removal M-8 (scripts/lib/lessons, Recall: hook obligation, config/AGENTS.md + delivery-loop references, docs). Scope: that repo only, branch+PR, Luna judges. Budget: 2 worker sessions + 2 repairs.
- T2 krn-codex-skills: memory reader accepts HTTPS-git and URN sources (read-cli.mjs sourceState returns source_unavailable for 15 HTTPS + URN records in krn-memory). Scope: reader + tests, no network fetch policy change without ADR. Budget: same.
- T3 frontend-system fs-006 / Paperclip LON-19: required visible text must not pass via a hidden descendant. Scope: its owner seam + tests only, no tools/auth/permissions; branch only, NO push/PR (repo CI off; publication needs operator). Budget: same.
Interruption (same for arm B): session 1 works until its first falsifier is red AND committed locally, then stops
and leaves today's continuity artifact (delivery-loop capsule `.krn/runs/delivery-loop/<id>/state.md`). Session 2 is a
fresh Luna session given only: repo path, task id, "resume".
Metrics per task (from logs; operator minutes recorded too, expected ~0 in both arms):
lead interventions in session 2 (count + text), reconstruction prompts, wall time to first useful action and to done,
tokens (both sessions), lost or redone work, judge rounds, outcome. Unknowns kept as unknown.
Record: evals/journeys/j1-baseline.json in ~/coding/krn/active/krn (lead readback; n=3, labeled).
Note for G3: operator minutes are ~0 in the current lead loop, so the kill criterion (-30% operator minutes) must be
reconsidered toward lead interventions + wall time + tokens.
