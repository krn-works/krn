# LON-20 standards packet

**Policy evaluation.** Reason about the semantic target of a rule separately from ancestors that provide context. Keep positive cases, direct overrides, nested selectors, and protected-child behavior distinguishable. Preserve existing canonical behavior and public extension points. A narrow policy correction should not become a general cascade engine or broaden unrelated restrictions. Use parser-provided structures without casts that erase uncertainty. A focused behavior check should cover both allowed context and forbidden target changes; typechecking alone does not establish policy behavior.

**Exemplar from a different accepted CSS-policy change.** Commit `57a77cd82ed642f51a57d27f5d42dcdbc39ea6cc`, available at base `f57c8543c5c0021da4399939789610b738863134`; quoted from `harness/workshop/src/rules.ts` at that base:

```ts
// Overlapping mechanical properties, not a second cascade/value resolver.
```

This keeps two policy modes explicit at the observation boundary. Maintain the same separation between rule context and rule target, and retain regression controls for both sides.
