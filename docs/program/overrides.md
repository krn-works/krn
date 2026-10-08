Every lead override of a judge FAIL is recorded here before merge.

| date | slice/PR | judge verdict | lead decision | reason | evidence |
|---|---|---|---|---|---|
| 2026-10-07 | krn S1-merge G1 drift test layer | FAIL | merge | gate red on AGENTS drift verified (exit 1, file untouched) | lead probe |
| 2026-10-08 | krn S4c | FAIL (procedural, intra-branch parent) | merge | slice falsifiers red on main 9dd36c2 per first judge | judge J-S4c run 1 |
| 2026-10-08 | krn S6' | FAIL (procedural, new-file import at base) | merge | base falsifier in test/s4i-authority.test.ts fails by assertion | J-S6p run 3 |
| 2026-10-08 | krn S5 | FAIL (non-atomic board write) | merge | Paperclip PATCH has no precondition (server/src/routes/issues.ts); residual risk accepted; post-write conflict comment + human_decision | J-S5 run 3 |
