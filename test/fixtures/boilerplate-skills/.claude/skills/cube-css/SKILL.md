---
name: cube-css
description: Write or change CSS of this WordPress theme the CUBE CSS way (global, composition, utility, block, exception) with SugarCube design tokens and Every Layout compositions. Use for any stylesheet edit, a new block, a new token or a layout problem; a new page component starts in acf-component.
---

# CUBE CSS

The theme (`web/app/themes/rekurencja-theme/`) follows Andy Bell's CUBE CSS,
Every Layout and Utopia fluid scales. Goal: as little CSS as possible; the
browser decides layout from rules, the block only configures what the layers
above already do.

> "The end-goal is shipping as little CSS as possible—leaning heavily into
> progressive enhancement and modern techniques." —
> [piccalil.li/blog/cube-css](https://piccalil.li/blog/cube-css/)

## Requirements

- The local runtime from wp-runtime (DDEV up, `mise run install` done).
- **agent-browser** (a skill of the agent's host, not of this repository) to
  look at and measure the rendered page. Without it: `mise run check:browser`
  writes full-page screenshots at 390 and 1280 px to
  `.cache/browser-check/`; for numbers, a short Node script with the
  project's pinned `playwright` (`import { chromium } from 'playwright'`,
  `getBoundingClientRect()`, `getComputedStyle()`).

## Layer owners

Source order is the cascade. `src/css/main.css` imports, in this order (no
`@layer`):

| Layer | Files | Owns | Never |
|---|---|---|---|
| Reset | `global/reset.css` | UA margins off, `body { min-height: 100vh }` | design decisions |
| Tokens | `src/design-tokens/*.json` → SugarCube → `--space-*`, `--size-step-*`, `--color-*`, … | every value of space, type, colour, motion | hand-written CSS values |
| Global | `global/variables.css` (semantic aliases), `global/global-styles.css`, `global/fonts.css` | element defaults without classes (`:where()`), focus, selection, `.lede`, `.meta`, `.skip-link` | component selectors |
| Composition | `compositions/*.css` | layout skeletons configured by custom properties with fallbacks | colour, font, fixed sizes |
| Block | `blocks/<name>.css` | a component: sets tokens and composition variables, small visual treatment | layout the composition gives; `min-height`; literal lengths |
| Utility | `utilities/region.css`, `utilities/visually-hidden.css`, SugarCube classes (`flow-space-*`, `region-space-*`, `gutter-*`, `text-*`, `bg-*`, …) | one job each | groups of unrelated properties |
| Exception | `[data-*]` on a block or composition | a finite state or variant | classes, BEM `--`, `is-`/`has-` |

SugarCube's generated variables and utility classes load after `main.css`
(from `main.js`), so a utility class on markup wins over a block rule of equal
specificity.

Details: [compositions](references/compositions.md),
[tokens](references/tokens.md), [canon with sources](references/canon.md).

## Before you write a declaration

Ask in order; the first "no" is the fix.

1. **Layer.** Does the file's layer match what the declaration does? Colour in
   a composition, layout in a utility, a component selector in globals: move it.
2. **Already owned.** Does a global default, composition, token or utility
   already produce it? Then delete the declaration or set the composition's
   variable (`--gutter`, `--flow-space`, `--region-space`, `--sidebar-*`, …).
   Section spacing is `.region` + `--region-space`, never `padding-block` in a
   block.
3. **Purpose.** Which content, design relationship or accessibility need
   requires it? No purpose: remove it.
4. **Token.** Every space, size, colour, leading, weight, radius and duration
   is a token or a semantic alias from `variables.css`. No arithmetic on the
   scale (`calc(var(--space-m) * 2)`): pick the step or the pair (`--space-m-l`).
5. **Units.** Fluid values come from the generated steps, never a new
   `clamp()`. Measure in `ch`, relative sizes in `em`, unitless line-height,
   logical properties (`margin-block-start`, `padding-inline`, `inline-size`).
6. **Specificity.** The block class is the only boost: block class plus flat
   `__element` children, nesting at most one level for small flourishes. No
   `#id`, no `!important` (only absolute accessibility overrides with a
   comment), no `:is()` as a boost, no `div.card`.
7. **Exception.** A variant is a `data-*` attribute with a finite set of
   values, landmarked with `/* EXCEPTION: … */`. When the variant no longer
   looks like the block, write a new block.
8. **Size.** A block solves one problem in a handful of rules (80-100 lines at
   most). Delete what your change made dead.
9. **Browser as mentee.** No fixed width, height or breakpoint that encodes one
   frame. Prefer `flex-wrap`, `minmax`, `auto-fill`, a composition setting;
   media queries only for small adjustments. It works at 320 px, with enlarged
   text and in landscape.
10. **States.** Interactive things have hover, `:focus-visible`, active,
    disabled/open where relevant and honour `prefers-reduced-motion`; never
    remove `outline` without a visible replacement.

## Enforced rules and the alternative

`check:css` (Stylelint, `stylelint.config.js`) fails these; do not disable a
rule to get past it. A disable needs a description and a reviewer's yes.

| Forbidden | Where | Use instead |
|---|---|---|
| `clamp()` | everywhere | a fluid token step (`--space-s-l`, `--size-step-3`); a new fluid value is a new token in JSON |
| `@layer` | everywhere | source order in `main.css` |
| BEM modifier `--`, `.is-*`, `.has-*` classes | everywhere | `[data-*]` exception; current page is `[aria-current='page']`, open is `[aria-expanded='true']` or `[open]` |
| `min-height`, `min-block-size` | blocks | height from content; section padding from `.region`; a ratio from `.frame` + `--frame-ratio` |
| `position: absolute` | blocks | `.imposter` over a `position: relative` ancestor (`.wrapper` is one); a described `stylelint-disable` only for a decoration that must not take space |
| literal lengths for spacing (all layers); literal `px`/`rem` dimensions (blocks); non-token type, colour, background (globals, utilities) | see the rule | tokens; composition dimension variables (`--sidebar-target-width`, `--grid-min-item-size`, `--switcher-target-container-width`, `--wrapper-max-width`) set in a block must be a `min()`/`max()`/`calc()` expression, e.g. `--grid-min-item-size: min(160px, 100%)`; a bare `160px` fails |
| `calc(var(--space-*) * n)` | spacing properties | the right step or pair |
| `max-width: none` in blocks | blocks | do not set width at all |
| `rem` | hand-written CSS, media queries included | `px` literals; `rem` lives only in the generated fluid scale (Utopia via SugarCube), so text still follows the reader's font-size setting |
| `http(s)` `url()` | everywhere | local assets (no foreign origins: `check:browser`) |
| a CSS file not imported once in `main.css` | `src/css` | add the import in its layer, alphabetical (`tests/css-imports.test.mjs`) |

Prefer a composition that switches on its container (`switcher`, `sidebar`,
`grid`) over a media query; the hero does. When a block needs one, a media
query length must be a viewport token in px from `design-tokens/viewports.json`
(`330px`, `760px`, `1230px`; CSS has no `var()` in `@media`), enforced by
`tests/css-imports.test.mjs`. Do not invent new breakpoints.

## Procedure for a block

1. Write the markup first: semantic HTML (`a` goes somewhere, `button` acts),
   then `region` + `wrapper` for a section, then compositions
   (`sidebar`, `grid`, `cluster`, `flow`, `frame`, …) as classes on the
   elements that lay out children.
2. Look at the page with no block CSS. Globals and compositions should already
   give most of the result.
3. Add `blocks/<name>.css` with a header comment (what it is, which
   composition it configures) and import it. Set composition variables and
   tokens first; add own properties only for what no layer owns.
4. Express variants as `data-*` exceptions; editors choose content, so the
   value comes from content (for example media position), not a style field.

Example from the theme (`blocks/media-content.css` + `sidebar` exception):

```html
<div class="media-content region">
  <div class="wrapper">
    <div class="media-content__layout sidebar" data-direction="rtl">
      <div class="frame">…</div>
      <div class="media-content__body">…</div>
    </div>
  </div>
</div>
```

```css
.media-content { --flow-space: var(--space-m); }
.media-content .frame { --frame-ratio: var(--ratio-media); }
```

## Verify

```bash
mise run check:css        # Stylelint token discipline
mise run check:test       # includes CSS import order (tests/css-imports.test.mjs)
mise run check:budget     # built CSS/JS within budget
mise run check            # every container-free gate
mise run check:browser    # overflow at 320, 390 and 1280 px, axe, console; with and without `mise run dev`
```

Look at the rendered page at 390 px and 1280 px (agent-browser screenshot, or
the `check:browser` screenshots; see Requirements) and report what you saw; a
passing lint is not a visual result.
