---
name: design-to-build
description: Turn a design (Figma frame, screenshot, mock-up or brief) into pages of this WordPress theme, planning before code and building in a core pass and a flair pass. Use when a client design arrives or a page has to be built from a picture; per-component steps live in acf-component and CSS rules in cube-css.
---

# Design to build

The design is an impression; the website is the source of truth. This skill
is the order of work from a design to accepted pages. It does not replace
the component procedure (acf-component) or the CSS rules (cube-css).

> "Figma is not the source of truth, the website is." — Complete CSS 07-1
> ([piccalil.li/complete-css](https://piccalil.li/complete-css))

Sources and quotes for each step: [references/process.md](references/process.md).

## Output

Keep one plan file outside the repository (your scratchpad) while you work;
nothing of it is committed. At the end the operator gets:

1. **Design feedback**: a list of problems in the design, each with the
   frame or region, what goes wrong and a proposed simpler solution. Facts,
   no opinions, never personal.
2. **Sketch-up**: per page, which regions, which compositions, which existing
   components cover them, what globals already handle.
3. **Backlog**: one task per page element, marked `core` or `flair`, and
   an Icebox of ideas outside the scope.
4. The built pages and the evidence (checks, screenshots at 390 px and
   1280 px).

## Procedure

A brief without pictures still goes through steps 1–6: the feedback lists
gaps in the brief (missing content, states, limits) instead of frames, and the
sketch-up maps the brief's sections to layouts.

1. **Scope.** Write down what is in scope. Anything outside goes to the
   operator as a note, not as a silent change. Ideas go to the Icebox.
2. **Read the design before code.** List oversights: missing small-viewport
   frames, missing states (hover, focus, open, empty, long text), values
   off the scale, one-off variants of the same thing, contrast that depends on
   CMS content. Simplify complexities instead of copying them.
3. **Design feedback.** Write the list for the operator (output 1). Ask the
   operator only about decisions that change the build; continue with
   everything else.
4. **Sketch-up.** For each page answer: which layouts, which are shared, which
   content regions, what the globals solve, what needs discussion. Map each
   region to an existing `flexible_page` layout first; a new component only
   when no existing one carries the content.
5. **Scale.** Take values, not variables, from the design: type sizes and
   spaces to the nearest step of the token scale, grid then gutter. Do not
   chase a pixel or two; consistency wins. A real new value is a token
   (cube-css, references/tokens.md).
6. **Backlog.** One task per element, split into passes:
   - **core**: tokens and global variables, global styles, compositions, core
     blocks, simple states, exceptions; the minimum viable experience;
   - **flair**: complex modules, JS as progressive enhancement, animation,
     page compositions, snags, anything that slowed the core pass.
7. **Prototype only risky layouts.** A throwaway prototype (scratchpad, not
   the theme) may use pixels and magic numbers, but still semantic HTML and
   globals first. Delete it after you know the answer.
8. **Core pass.** In the cascade order of `main.css`: tokens, globals,
   compositions, blocks, utilities, exceptions. Each component through
   acf-component; each stylesheet through cube-css. The agency's logo in
   `header.php` and `footer.php` is a placeholder: replace it with the
   client's. Small pieces; note refactors in the backlog and carry on.
9. **Flair pass.** Progressive enhancement on top of the minimum viable
   experience; motion only under `prefers-reduced-motion: no-preference`.
10. **Page composition.** Pages are rows of `flexible_page`: put content
    together, write no CSS at this step. Seed local content so
    `check:browser` renders every component.
11. **Snags.** Compare the rendered page, not the design file, at 320, 390
    and 1280 px. For each snag the operator raises, state the cost in time and
    offer a simpler option when it is expensive.
12. **Document.** A short header comment at the top of every new CSS file and
    template (what it is, which composition or profile it uses).

## Done when

- every backlog `core` task is built or moved with a reason;
- `mise run check` = 0, `mise run doctor` passes, `mise run check:browser`
  passes with and without `mise run dev`;
- screenshots at 390 px and 1280 px of each built page were looked at and
  described;
- the operator has the design feedback, the Icebox and the list of open
  snags.

## Do not

- Copy the design pixel for pixel with fixed heights, breakpoints per frame or
  absolute positioning.
- Give editors a style choice to reproduce a one-off look; the component
  picks the look by profile.
- Start code before the design feedback and the sketch-up exist.
- Build flair before the core pass works on a small viewport.
