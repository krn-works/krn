# LON-21 standards packet

**Measurement evidence.** Acceptance criteria and observed artifacts have separate owners. Validate the received bytes at runtime, bind the report to those exact bytes and their revision, and refuse legacy call shapes that cannot establish independence. Keep malformed evidence, missing evidence, a valid negative observation, and a real behavior defect distinguishable. Do not infer independent authorship from a self-supplied digest. Preserve the limits of static checks and mocks; they cannot establish browser execution or an external author’s identity.

**Exemplar from another accepted measurement change.** Commit `65d328e661e3b47f8dd1e351385d14b6ed0300e5`, present at base `7f2be36eac60470dad9c0446f1dfe82947783915`; quoted from `harness/workshop/src/author-measure.ts` at that base:

```ts
const before = await fingerprintInputs(root);
if (JSON.stringify(before) !== JSON.stringify(identity.inputs))
```

This compares observed inputs with the build identity before measurement. Preserve provenance through the complete acceptance path and report when the available evidence cannot support a verdict.
