# LON-22 standards packet

**Effect boundaries.** Treat submitted markup and styles as untrusted source. Preserve the original bytes for audit, inspect effects at each boundary that can trigger them, and refuse unsupported navigation requests explicitly. Keep source refusal, frozen-artifact integrity, and browser/network behavior as separate claims. Do not rewrite input and then claim the original was safe. Positive cases and deterministic negative cases should cover the actual public boundary. Static policy evidence does not prove isolation from every browser or network effect.

**Exemplar from another accepted source-integrity change.** Commit `a2aea8be56b5976608e9b93c54a597af071b5968`, available at base `459cce9a330636559a80ff923dab735cbefd3651`; quoted from `harness/workshop/src/observe.ts` at that base:

```ts
copy.append(suffix);
```

The accepted change appends a distinct node so original markup and listeners remain intact. Boundary checks should retain the submitted representation and refuse disallowed effects without silently normalizing away the evidence.
