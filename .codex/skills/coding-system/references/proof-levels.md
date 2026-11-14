# Proof Levels

Use the lowest proof level that genuinely proves the acceptance criteria.

## Levels

1. **Static proof:** types, lint, formatting, schema validation, generated-file diff.
2. **Unit proof:** narrow automated test of one behavior through a stable public interface.
3. **Integration proof:** multiple modules or services exercised together.
4. **Runtime proof:** local app/server/container/CLI actually runs and returns expected output.
5. **Rendered proof:** browser/UI/screenshot/canvas/DOM/network proof for visual or interaction work.
6. **Remote proof:** staging, production, external API, CI, GitHub Actions, or deployed URL.

## Reporting

Report proof as:

```text
Proof: <command/check>
Result: <pass/fail/blocked>
Covers: <acceptance criterion>
Does not cover: <remaining surface>
```

Never collapse levels. A passing unit test is not proof that production checkout works. A local HTTP 200 is not proof that deployed routing works.
