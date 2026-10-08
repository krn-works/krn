# LON-20 standards packet

**Standards / pitfalls.** Keep correction at the existing CSS parser/policy seam and distinguish final selector subject from ancestor context. Legal .wrapper .card must pass while true wrapper override and forbidden reel-child change remain blocked. Preserve other positives/negatives and canonical CSS/token/API behavior; do not add a general cascade resolver, dependency or broader policy. Infer parser AST types; no cast/suppression shortcut. Add one focused runtime falsifier to existing test, show behavioral failure on unchanged implementation, then run same check green. Typecheck is static evidence only; complete npm run check is required.

**Sources.** frontend-system/AGENTS.md:84-88,109-116,295-305; krn/docs/program/blueprint.md §9 K3-K8; accepted fix a262a5fb97018c479fb682ccc884bfa03100c591.

**Exemplar accepted diff.** SHA a262a5fb97018c479fb682ccc884bfa03100c591:
```diff
+// The final compound targets the element; preceding compounds only supply context.
```
