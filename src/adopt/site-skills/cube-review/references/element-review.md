# Element review: design versus render

A review that confirms the order of sections but does not measure the
elements lets through the wrong icon, a missing current state, a heading a
few percent narrower than designed and sections with the wrong rhythm. This
file is the method for step 6 of the review.

## Method

1. **Three passes.**
   (a) Look at full-size crops of design and render side by side and list
   every difference you see before measuring; write your own list before you
   read the author's.
   (b) Element by element with the table below.
   (c) Relations: grid edges, axes, rhythm of spaces as roles (the same role
   has the same space everywhere).
2. **Same scale.** Design frame and render at the same viewport width, 100%
   zoom; small elements (icons, separators, underlines) also zoomed 3-4x. A
   half-scale or full-page preview is not evidence.
3. **Numbers from both sides.** Render: `getBoundingClientRect()`,
   `getComputedStyle()` or screenshot pixels (agent-browser `eval`). Design:
   the values in the design file or the brief. Measure **text width on the
   rendered glyphs** (a `Range` around the phrase), not only the declared
   `font-size`: equal sizes with a different phrase width mean another font,
   weight or a stray `font-size-adjust`.
4. **States.** Current page and its ancestor in navigation at rest; hover and
   focus on links and buttons; open and closed for disclosures.
5. **Design values off the scale.** Round to the nearest token step, propose a
   new role when two or more places share it, or list it as design feedback.
   Never let a one-off value through silently.

## Checklist per section

| # | Element | Compare |
|---|---|---|
| 1 | text | every string word for word, punctuation, case; placeholder text in the design is marked as such |
| 2 | typography | family, size, weight, line height, colour, tracking, transform, underline, phrase width |
| 3 | icons | glyph, colour, box and glyph size, position |
| 4 | separators and decoration | glyph, lines, borders, corners, backgrounds and gradients (type, direction, end colours) |
| 5 | states | current, hover, focus-visible, open |
| 6 | geometry | section padding, spaces between elements, measure, column widths, grid edges |
| 7 | images | crop, ratio, side (left or right), vertical position |
| 8 | contrast | text on images and coloured surfaces; content from the CMS may change |

## Table

Each section gets:

```text
element | design (number) | render (number) | difference | weight | file:line
```

"Matches" is written only with numbers on both sides. A row without a
measurement goes to "Not checked", never to "matches". Decide the section's
verdict after the whole table.

## What is a defect

- **Defect:** any difference in rows 1-5 and 8; a geometry difference that
  changes the visible rhythm (role of a space, measure, alignment to the
  grid, missing element or padding); phrase width off by 2% or more.
- **Not a defect (write the reason):** section height that follows a
  different length of real content (height is content plus region space,
  never the frame height of the design); number of items that follows the
  content; placeholders and typos in the design; a recorded operator
  decision (name where it is recorded).
- A deviation without one of these reasons is a defect to fix, not a
  "normalisation".
