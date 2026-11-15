# Design tokens

Tokens are the single source of every space, type, colour and motion value.
JSON in `web/app/themes/rekurencja-theme/src/design-tokens/` (W3C design
token format) → SugarCube (`@sugarcube-sh/vite`, `sugarcube.config.js`) →
CSS custom properties and utility classes in the virtual module
`virtual:sugarcube.css`, imported by `main.js` after `main.css`.

> "design tokens are a single source of truth" —
> [cube.fyi/utility](https://cube.fyi/utility.html)

## Files and generated names

| File | Generated variables |
|---|---|
| `spacing.json` | `--space-zero`, `--space-3xs` … `--space-4xl`; pairs `--space-3xs-2xs` … `--space-3xl-4xl`, `--space-s-l`, `--space-s-xl` |
| `text-sizes.json` | `--size-step-01`, `--size-step-00`, `--size-step-0` … `--size-step-6` |
| `text-leading.json` | `--leading-flat`, `--leading-fine`, `--leading-compact`, `--leading-standard`, `--leading-loose` |
| `text-weights.json` | `--font-weight-regular`, `--font-weight-medium`, `--font-weight-bold` |
| `fonts.json` | `--font-base`, `--font-display`, `--font-mono` |
| `colors.json` | `--color-dark`, `--color-light`, `--color-surface`, `--color-muted`, `--color-primary`, `--color-accent`, `--color-focus`, `--color-bg`, `--color-text`, `--color-selection-bg`, `--color-selection-text` |
| `motion.json` | `--duration-fast`, `--duration-base`, `--duration-slow`, `--duration-slower`, `--ease-standard`, `--ease-linear`, `--ease-overshoot` |
| `viewports.json` | `viewport.min`, `viewport.mid`, `viewport.max`: the fluid range of every scale |

Space and size steps are fluid: each token's `sh.sugarcube.fluid` holds a min
and max value, and SugarCube emits the `clamp()` between `viewport.min` and
`viewport.max`. That is why hand-written `clamp()` is forbidden: the scale
already interpolates. A pair (`--space-s-l`) grows from the smaller step at
the narrow end to the larger at the wide end; use a pair for gaps that should
open up on wide screens.

> "fluid type and space scales basically power your entire UI and simplify
> decision making" —
> [piccalil.li/blog/reality-check-1-building-out-a-furniture-site-from-dribbble](https://piccalil.li/blog/reality-check-1-building-out-a-furniture-site-from-dribbble/)

## Semantic aliases

`src/css/global/variables.css` names roles on top of the scale. Blocks read
roles, not raw steps, when a role exists:

| Role | Variables |
|---|---|
| Layout | `--gutter`, `--wrapper-max-width`, `--measure` (`65ch`), `--measure-compact` (`45ch`), `--ratio-media` |
| Shape | `--radius-s`, `--radius-m`, `--radius-l`, `--stroke` |
| Surface | `--body-bg`, `--body-color`, `--focus-color`, `--focus-ring-offset`, `--selection-bg`, `--selection-text` |
| Type | `--text-size-eyebrow`, `--text-size-base`, `--text-size-lede`, `--text-size-meta`, `--text-size-code`, `--text-size-heading-1` … `-4`, `--heading-font-family`, `--heading-font-weight`, `--paragraph-font-family`, `--kerning`, `--kerning-tight`, `--kerning-caps` |
| Motion | `--transition-base`, `--transition-movement`, `--transition-fade`, `--transition-bounce` |

A block exposes its own knobs as `var(--block-prop, <role token>)` (see
`blocks/button.css`: `--button-bg`, `--button-padding`, …) and lets exceptions
re-set those knobs. It never redefines a global variable for the whole page.

## Generated utilities

`sugarcube.config.js` emits classes only for names it finds in the theme's
`*.php`, `inc/**/*.php` and `components/**/*.php` (`vite.config.js`), unless
`safelist: true`. A class built at runtime, or stored in the database or
editor content, is never generated; write the full class name in PHP:

| Prefix | Sets | Safelisted |
|---|---|---|
| `text-<color>`, `bg-<color>`, `border-<color>` | `color`, `background-color`, `border-color` | `text-*` |
| `m-*`, `p-*` with directions `x`, `y`, `top`, … | margin, padding | no |
| `gap-<space>` | `gap` | no |
| `text-<step>` | `font-size` | yes |
| `leading-*`, `font-*` | `line-height`, `font-family`/`font-weight` | no |
| `text-weight-*`, `text-leading-*` | `--text-font-weight`, `--text-line-height` | yes |
| `flow-space-<space>` | `--flow-space` | yes |
| `region-space-<space>` | `--region-space` | no |
| `gutter-<space>` | `--gutter` | no |

Prefer a CUBE variable utility (`flow-space-*`, `region-space-*`,
`gutter-*`) in markup over a new block rule when only one instance differs.

## Adding or changing a token

1. Measure first: a value one or two pixels off the scale is the scale's
   value; focus on consistency.

   > "don't get hung up on that, and instead, focus on consistency" —
   > Complete CSS, module 03 (Planning and feedback), lesson 7
2. Add it to the JSON file with `$type`, `$value` and, for space or size, a
   `sh.sugarcube.fluid` min/max. Generate new scales with Utopia
   ([utopia.fyi](https://utopia.fyi/)) and record the calculator URL in
   `$extensions.scaleGenerator`.
3. A role name goes into `variables.css` only when two or more places share
   the role.
4. Run `mise run build` (or `mise run dev`) and `mise run check:css`.
