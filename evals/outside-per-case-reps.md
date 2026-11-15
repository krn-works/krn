# Outside rows graded per hidden case, repeated, each miss classified

Harness: the summary row now ends with `failed <case> ...` naming each failed hidden case (pytest `FAILED`, TAP `not ok`, PHP shim `FAIL`), and `--reps N` repeats each selected row serially from a fresh clone. The hook cell matched the tree under test (`HEAD` of the lane worktree) on every graded row. Command: `node --experimental-strip-types scripts/outside-acceptance.ts --task-file scripts/outside-hidden/discriminating-tasks.json --stack <row> --reps N --window-hours 7`, scratch `/mnt/storage/tmp/krn-outside-public`.

Population: the three rows below 100% in `outside-discriminating-rows.md`. Recorded before the runs: K x3 each; a rep that fails before a worker produced a graded tree (infrastructure) is excluded from the counts and listed.

## Per-case table (graded reps)

| row | rep | cases | failed cases | classification |
| --- | --- | --- | --- | --- |
| py-sweep | 1-3 | 11/11 x3 | none | the earlier 9/11 did not reproduce: two skipped clauses of a five-symptom body, noise |
| py-fs-sweep | 1 | 5/7 | test_non_identifier_alnum_name[namedtuple], [namedlist] | unguessable behavior: the body said "rename=True does not rename"; the held-back case asserts ValueError without rename. The worker did what the body said. |
| py-fs-sweep | 2 | 5/7 | the same two | the same |
| py-fs-sweep | 3 (body fixed) | 7/7 | none | the row body now states the SyntaxError-instead-of-ValueError symptom |
| py-mistune-image-depth | 1-2 (body fixed) | 3/3 x2 | none | before the fix the hidden case asserted `InlineParser().max_image_depth == 20`, a name and default no body stated: unguessable name |

Classification counts over every missed case seen (original batch plus these reps): skipped clause 2 (py-sweep, once, not reproduced), wrong fix 0, unguessable name or behavior 3 (image-depth setting, namedtuple and namedlist ValueError, the last two repeating).

Excluded (infrastructure, not worker misses): one py-fs-sweep rep whose lane push hit a stale `t-<id>` branch an earlier run left on the remote (fixed in the harness: a row now deletes lane branches that descend from its own orphan base); eight reps refused or unable to run because `doctor --unattended` found a vault session of 7.9h against the 8h window (run with `--window-hours 7`).

## Rows below 100% after the body fixes

None measured below 100%: py-sweep 11/11 (x3), py-fs-sweep 7/7 (x1), py-mistune-image-depth 3/3 (x2). The two body fixes have one and two graded reps, not three.

Spend of this measurement: about $1.8 (py-sweep $0.70, py-fs-sweep $0.79, image-depth $0.33).
