# Compositions

A composition is a layout skeleton, independent of the component inside it.
It is configured by custom properties that have sensible fallbacks; a block
sets those properties and does nothing else for layout.

> "Our `masthead` is providing definitions for the compositional layout's
> custom properties and doing nothing else." — Complete CSS, module 04
> (Design prototyping), lesson 2, [piccalil.li/complete-css](https://piccalil.li/complete-css)

All files live in `web/app/themes/rekurencja-theme/src/css/compositions/`.
`--gutter` is the shared gap variable; its global default is
`var(--space-s-l)` (`global/variables.css`).

## Which one

| Need | Composition | Every Layout |
|---|---|---|
| Vertical rhythm between siblings | `flow` | [Stack](https://every-layout.dev/layouts/stack/) |
| Centred, max-width content with side gutter | `wrapper` | [Center](https://every-layout.dev/layouts/center/) |
| Items of different length that may wrap (buttons, tags, nav) | `cluster` | [Cluster](https://every-layout.dev/layouts/cluster/) |
| Two groups pushed apart, stacking when tight (logo + nav) | `repel` | (Piccalilli) |
| Fixed-ish side + fluid main, intrinsic 1↔2 columns (media + text) | `sidebar` | [Sidebar](https://every-layout.dev/layouts/sidebar/) |
| Two items side by side above a container width, equal or weighted by `flex-grow` (hero: 3 to 2) | `switcher` | [Switcher](https://every-layout.dev/layouts/switcher/) |
| Teaser or card collections, auto-filled columns | `grid` | [Grid](https://every-layout.dev/layouts/grid/) |
| Horizontal scrolling row with snap | `reel` | [Reel](https://every-layout.dev/layouts/reel/) |
| Media crop with a ratio | `frame` | [Frame](https://every-layout.dev/layouts/frame/) |
| A child escaping the wrapper to full viewport width | `breakout` | (Piccalilli) |
| An overlay centred over its container (badge, caption, dialog) | `imposter` | [Imposter](https://every-layout.dev/layouts/imposter/) |

Not in the theme: Cover, Box, Icon. Add one (file + import +
documented API) when a real component needs it instead of writing
`position: absolute` or `min-height` in a block.

> "Wherever content needs to be deliberately obscured, the Imposter pattern is
> your friend." — [every-layout.dev/layouts/imposter](https://every-layout.dev/layouts/imposter/)

## API

| Class | Variables (fallback) | Exceptions |
|---|---|---|
| `.flow` | `--flow-space` (`1em`): margin before every child after the first | none; set `--flow-space` on a child to change one gap |
| `.wrapper` | `--wrapper-max-width` (`1216px` global), `--gutter` (inline padding) | none |
| `.cluster` | `--gutter` (`--space-s-m`), `--cluster-horizontal-alignment` (`flex-start`), `--cluster-vertical-alignment` (`center`) | none |
| `.repel` | `--gutter` (`--space-s-m`), `--repel-vertical-alignment` (`center`) | `[data-nowrap]`: never wrap |
| `.sidebar` | `--gutter` (`--space-s-l`), `--sidebar-target-width` (`320px`, first child), `--sidebar-content-min-width` (`50%`, last child) | `[data-direction='rtl']`: first child on the right; stacked it stays on top |
| `.switcher` | `--gutter` (`--space-s-l`), `--switcher-target-container-width` (`640px`), `--switcher-vertical-alignment` (`flex-start`) | a third child and later go full width |
| `.grid` | `--gutter` (`--space-s-l`), `--grid-min-item-size` (`256px`, capped at `100%` by `min()`), `--grid-placement` (`auto-fill`), `--grid-template-columns` (explicit override) | none |
| `.imposter` | `--imposter-position` (`absolute`; `fixed` over the viewport), `--imposter-margin` (`0px`, with `data-contain`) | `[data-contain]`: capped at the container minus the margin, overflow scrolls |
| `.reel` | `--gutter` (`--space-s-m`), `--reel-item-width` (`min(80vw, 352px)`) | none |
| `.frame` | `--frame-ratio` (`16 / 9`); theme alias `--ratio-media` (`4/3`) | none; it crops (`object-fit: cover`), so a logo or diagram that must stay whole sets `object-fit: contain` on its image in the block |
| `.breakout` | none | none |

`.region` (utility, not a composition) pads a section: `--region-space`
(`--space-xl-2xl`). Every page section is `region` + `wrapper`.

## Rules

- Configure, do not override: `.hero__layout { --gutter: var(--space-l-xl); }`,
  not `gap: …` in the block.
- A composition holds no colour, font or fixed size of a component. One
  accepted exception: `reel` tints its own scrollbar (`scrollbar-color`),
  because the scrollbar is part of the layout primitive, not a component.
- Media queries are adjustments, not the layout: the intrinsic switch
  (`flex-wrap`, `flex-basis` with `999`, `minmax`) does the responsive work.

  > "Rather than specifying column sizes in media queries or container
  > queries, we are letting the browser work for us" — Complete CSS,
  > module 02 (Principles), lesson 6
- When no composition fits and a new one would be too complex, write specific
  code in the block.

  > "try to solve most of your layout needs with compositional layouts,
  > because that means most of your UI is rock solid" — Complete CSS,
  > module 02, lesson 6
- Flow uses margins, so it works in any display context; `gap` needs a flex or
  grid parent.
- Port Every Layout state classes (`.reel.overflowing`, `.box.invert`) to
  `data-*` exceptions.
- A new composition: header comment with "CUSTOM PROPERTIES AND
  CONFIGURATION" and "EXCEPTIONS" like `sidebar.css`; import it alphabetically
  in the compositions section of `main.css`.
