# LON-21 standards packet

**Standards / pitfalls.** Expected criteria/observation are untrusted; case bytes arrive independently from integrator/receiver. Validate at runtime, hash exact bytes and bind acceptance to them. A self-supplied raw case/hash cannot restore trust; old call shapes must not regain authority. Keep malformed/missing independent input, coordinated criterion substitution, valid measurement and actual behavior fault as distinct outcomes. Do not claim PKI or browser-artifact authenticity outside the contract. Preserve existing tests and report real full-check evidence; mocks do not prove a browser or independent author.

**Sources.** frontend-system/AGENTS.md:84-88,292-305; krn/docs/program/blueprint.md §9 K7-K8; accepted fix c7eaee106ad6695405429373df2f252c82bddd47.

**Exemplar accepted diff.** SHA c7eaee106ad6695405429373df2f252c82bddd47:
```diff
-  expected: Expected,
+  expectedInput: Expected,
   input: unknown, har: unknown, condition: unknown,
+  caseBytes: string | Uint8Array,
```
