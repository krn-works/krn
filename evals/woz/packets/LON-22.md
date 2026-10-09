# LON-22 standards packet

**Standards / pitfalls.** Treat HTML/CSS and URL-bearing fields as untrusted. Check source before build and hash-verified frozen HTML/CSS before browser preparation. Refuse disallowed effects explicitly; do not rewrite source. Keep static refusal, controlled effects and input integrity as separate claims. This is not a universal sanitizer or network sandbox. Do not widen host permissions or add unrelated policy. Preserve positive controls and deterministic negatives; run targeted policy tests and full npm run check. Missing browser/network proof is missing, not inferred from static checks.

**Sources.** frontend-system/AGENTS.md:84-88,109-116,295-305; krn/docs/program/blueprint.md §9 K7-K8; accepted PR #20, SHA a43a99c77e9b311d508b0072f3dddd7a00445e9a.

**Exemplar accepted diff.** SHA a43a99c77e9b311d508b0072f3dddd7a00445e9a:
```diff
+const urlAttributes = new Set([
```
