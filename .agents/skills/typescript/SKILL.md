---
name: typescript
description: TypeScript only: inference, narrow exports, type-level boundaries (schemas at the edge, branded and discriminated types, no any or unsafe casts), tsconfig and module resolution, Node type-stripping limits, testing types. Use when writing or reviewing .ts code or tsconfig; for module design and seams use the architecture skill.
---

# TypeScript

TypeScript models JavaScript; it is not a runtime shield. Keep the compiler's relationships, validate values at runtime, and name every unsound claim. Module structure, seams, and depth belong to the `architecture` skill; this one covers how TypeScript expresses them. Adapted from the user skill `typescript-engineering`.

## Repo facts

- Scripts and `src` run as plain `node file.ts` (Node 24 type stripping): no transpile step. Only erasable syntax: no `enum`, `namespace`, parameter properties, or `import x = require`. `erasableSyntaxOnly` enforces it.
- Imports use the real `.ts` extension (`allowImportingTsExtensions`); `verbatimModuleSyntax` requires `import type` for type-only imports. `module` and `moduleResolution` are `NodeNext`; no path aliases.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are on: indexed reads are `T | undefined`; do not assign `undefined` to an optional property.
- `npm run check` is `tsc --noEmit` (tsc is the type authority; node never checks types). `npm run lint` is Biome.
- `zod` is the runtime schema library.

## Rules

1. **Infer inside, annotate at the edge.** Annotate exported function parameters and independent contracts; let return types and locals infer unless the return is a public contract. Use `satisfies` to check a literal without widening it.
2. **Parse at the edge.** External input (JSON, env, argv, files, process output) enters as `unknown` and is parsed once with a zod schema; derive the type with `z.infer`. Inside the edge, trust the parsed type.
3. **Make invalid states unrepresentable.** Discriminated unions over optional-field bags; exhaustive `switch` with a `never` check; branded types for ids that must not mix.
4. **No `any`, no unsafe casts.** Prefer `unknown` plus narrowing. When `as`, `!`, or `@ts-expect-error` is unavoidable, isolate the smallest scope, say why TypeScript cannot see the evidence, and put the runtime check where it could be false. Never silence an external value into trust.
5. **Narrow exports.** Export only what another module imports; keep schemas, helpers, and constants private. Do not use `export *`; a re-export-only barrel is a pass-through, so import the owner. Export types with `export type`.
6. **Simple types beat clever ones.** Prefer a union or overload that callers can read over conditional or mapped machinery; derive types from values when they share an owner, decouple them when consumers evolve apart.
7. **Prove it.** Run `npm run check` for any changed `.ts` or tsconfig. For a public relationship that could silently widen, add a compile-time proof (a `@ts-expect-error` line that must fail, or an assignability assertion type); use runtime tests only for runtime behaviour and parsed boundaries. Tests import what callers import.
