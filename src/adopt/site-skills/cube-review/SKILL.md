---
name: cube-review
description: Independently review a frontend diff of this WordPress theme (CSS, component templates, acf-json) and its rendered result before acceptance. Use in a fresh session that did not write the change; the author's own checks only prepare the handoff.
---

# CUBE review

Acceptance needs a reviewer other than the author: a fresh session or a
subagent that gets the revision, not the author's conclusion. The author may
run the same steps to prepare, but that is never acceptance.

The rules being checked live in the theme's skills: CSS in cube-css,
components in acf-component, order of work in design-to-build. Read the
SKILL.md of each that the diff touches before reviewing.

## Requirements

- The local runtime from wp-runtime (DDEV up, `mise run install` done).
- **agent-browser** (a skill of the agent's host, not of this repository) for
  step 6: screenshots and `eval` measurements at 320, 390 and 1280 px.
  Without it: `mise run check:browser` screenshots (390 and 1280 px, in
  `.cache/browser-check/`) plus a short Node script with the project's pinned
  `playwright` that sets each viewport and reads `getBoundingClientRect()`
  and `getComputedStyle()`. Name the substitute in the report.

## Inputs

- the exact revision or range (`git diff <base>..<head>`), not a description;
- the accepted scope (task, design feedback, operator decisions);
- the design or reference screenshots when the change is visible.

## Sequence

Stop at a step only for a blocking finding; record the rest and continue.

1. **Gates.** Run `mise run check` (exit 0) and, for theme or runtime
   changes, `mise run check:browser` with and without `mise run dev`. Read
   the output; a gate is a signal, not proof that a rule's intent holds.
2. **Diff, declaration by declaration.** For every changed CSS declaration ask
   the ten questions of cube-css ("Before you write a declaration"), in order;
   the first "no" is the finding. For templates and acf-json check the
   acf-component contract table.
3. **New names.** For every new token, variable, selector, `data-*` value,
   field or literal: who consumes it (grep the consumers), which role owns
   it, which existing global, token or composition variable it duplicates,
   and whether it would exist without one pixel value of the design. A
   pixel-only addition is a major finding with a reuse or removal proposal.
4. **Shared variables land where intended.** For every composition variable
   the diff sets (`--gutter` above all, also `--flow-space`,
   `--region-space`): list its readers in `src/css/compositions/` and confirm
   it reaches only the intended composition, not an element that also
   carries `.wrapper` and not descendants that inherit it by accident.
5. **Dead code and balance.** The diff removes everything its change made
   dead: declarations, selectors, variables, fallbacks, attributes, template
   branches, fields. State the line balance (`git diff --stat`). An override
   added in a consumer (redefining another block's variable, a longer
   selector, a `display: none` patch) where the owner could take a parameter
   is a finding.
6. **Rendered result.** Look at every touched section at 320, 390 and
   1280 px with agent-browser (own session: `--session <name>`; close it at
   the end) or its substitute from Requirements. Use the element table in
   [references/element-review.md](references/element-review.md): numbers on
   both sides, never "matches" without them. Check states (hover,
   `:focus-visible`, current page), long and empty content, enlarged text.
7. **Readback.** Hand the findings to the author; re-review only the points
   that changed materially. No extra rounds without new evidence.

## Report

```text
Revision: <sha> (base <sha>)
Gates: mise run check = <exit>; check:browser plain = <PASS|FAIL>, with dev = <PASS|FAIL>

file:line | layer | rule | evidence
src/css/blocks/hero.css:12 | block | spacing from .region, not padding-block | `padding-block: var(--space-l)` duplicates `.region` (utilities/region.css:6)

Rendered: <section> at 390/1280 px: <table rows or link to them>
Not checked: <what and why>
Verdict: accept | changes needed
```

`layer` is one of reset, token, global, composition, utility, block,
exception, template, acf. `rule` names the rule from the skill it breaks.
`evidence` is a quote of the line, a grep hit, a computed value or a
screenshot path. Report concrete defects, not style preferences.

## Verdict

- **Changes needed** when any finding breaks a rule of cube-css or
  acf-component, a gate fails, a visible difference has no recorded reason, or
  dead code stays.
- **Accept** only with gates green, every finding resolved or recorded as an
  operator decision, and the rendered sections measured.

A justified exception is a described `stylelint-disable` or a recorded
operator decision; check that its reason names a real role. A screenshot
cannot excuse duplicate ownership.
