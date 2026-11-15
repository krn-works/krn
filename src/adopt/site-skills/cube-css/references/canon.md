# Canon with sources

The theme's CSS rules come from Andy Bell's school (Set Studio, Piccalilli):
CUBE CSS, Every Layout, Utopia and the Complete CSS course. Quotes are
verbatim. Course lessons are cited as "Complete CSS mm-n" (module, lesson) of
[piccalil.li/complete-css](https://piccalil.li/complete-css); modules: 01
Intro, 02 Principles, 03 Planning and feedback, 04 Design prototyping, 05 Core
build, 06 Flair pass, 07 Page compositions, 08 Wrapping up.

## Principles

| Rule | Quote | Source |
|---|---|---|
| Give the browser rules, not orders | "give it a sensible ruleset and let it determine what's best for the user based on their actual circumstances" | Complete CSS 02-4 |
| There is no ideal viewport | "The problem with this is the ideal viewport doesn't exist" | Complete CSS 02-4 |
| The design file is an impression; the website is the truth | "Figma is not the source of truth, the website is." | Complete CSS 07-1 |
| Suggest, do not prescribe | "When we try to prescribe dimensions, things tend to go amiss." | [every-layout.dev](https://every-layout.dev/) |
| Work with the cascade | "The cascade and inheritance are embraced, not avoided" | [cube.fyi](https://cube.fyi/index.html) |
| Pragmatic, not dogmatic | "be pragmatic — not dogmatic — as a starting point" | Complete CSS 02-7 |
| Start global | "it's important to start global because the aim is to write as little CSS as possible." | [Reality check 1](https://piccalil.li/blog/reality-check-1-building-out-a-furniture-site-from-dribbble/) |
| New markup looks good by itself | "We want to get the front-end to a point that when someone adds markup, it behaves nicely and looks good." | Complete CSS 05-2 |
| Globals target unclassed elements | "we're deliberately targeting <a> elements without a class" | Complete CSS 05-3 |
| Zero-specificity defaults | ":where() has zero specificity. It's a global style, so we want this to be easily overridable in CUBE blocks" | Complete CSS 07-3 |
| Rhythm from flow, not UA margins | "I'll always favour stripping out user agent styles for margin in favour of defining flow and space at a more macro level." | [A more modern CSS reset](https://piccalil.li/blog/a-more-modern-css-reset/) |
| Nesting only for flourishes | "I would strongly recommend you only use nesting for little flourishes like this rather that going all in." | Complete CSS 05-3 |

## Tokens

| Rule | Quote | Source |
|---|---|---|
| JSON tokens generate CSS | "having JSON-powered design tokens allows us to both generate the CSS custom properties programatically" | Complete CSS 03-7 |
| Fluid scales power the UI | "fluid type and space scales basically power your entire UI and simplify decision making" | [Reality check 1](https://piccalil.li/blog/reality-check-1-building-out-a-furniture-site-from-dribbble/) |
| Generated clamps, not hand-written | "The `clampGenerator` generates Utopia-like CSS clamp values for fluid type and space" | [A CSS project boilerplate](https://piccalil.li/blog/a-css-project-boilerplate/) |
| Measure in characters | "ch (short for character) is the only appropriate unit for this styling task." | [every-layout.dev](https://every-layout.dev/) |

## Layers

| Layer | Quote | Source |
|---|---|---|
| Composition is a skeleton | "The composition layer’s job is to create flexible, component-agnostic layout systems that support as many variants of content as possible." | [cube.fyi/composition](https://cube.fyi/composition.html) |
| Composition has no visual treatment | "Provide visual treatment such as colour or font style" (listed under what it should not do) | [cube.fyi/composition](https://cube.fyi/composition.html) |
| Components are sized by the layout | "We build components to be sized and spaced by an outer, skeletal layout" | Complete CSS 02-6 |
| Configured by custom properties | "as much as possible is configured with custom properties, which in turn, have sensible fallbacks" | Complete CSS 02-6 |
| Media queries adjust | "that's exactly what media queries are good at: adjustments." | Complete CSS 04-3 |
| Queries are circuit breakers | "Both @media and @container queries are forms of manual intervention. They are circuit breakers" | [every-layout.dev](https://every-layout.dev/) |
| Utility does one job | "A utility, in the context of CUBE CSS, is a CSS class that does one job and does that one job well." | [cube.fyi/utility](https://cube.fyi/utility.html) |
| Utilities only when needed | "One thing we highly recommend is not including utility classes until you need them." | [every-layout.dev](https://every-layout.dev/) |
| Block extends the layers | "Extend the work already done by the global CSS, composition and utility layers" | [cube.fyi/block](https://cube.fyi/block.html) |
| Block stays small | "Grow to anything larger than a handful of CSS rules (max 80-100 lines)" (listed under what it should not do) | [cube.fyi/block](https://cube.fyi/block.html) |
| `__` elements are fine | "In CUBE we can still use the same syntax for elements as BEM — a double underscore (`__`) — if we want." | Complete CSS 02-7 |
| Exceptions are finite data attributes | "Modifiers — known as Exceptions in CUBE — are finite because we use data attributes in markup." | Complete CSS 02-7 |
| Landmark exceptions | "it's a good idea to landmark your exceptions with a CSS comment." | Complete CSS 05-8 |
| Too far is a new block | "Variate a block to the point where it isn’t recognisable anymore. This is where a new block should be created" (what an exception should not do) | [cube.fyi/exception](https://cube.fyi/exception.html) |
| No `@layer` needed | "we certainly don't need to use @layer or @scope in this context." | Complete CSS 08-3 |

## Progressive enhancement and accessibility

| Rule | Quote | Source |
|---|---|---|
| CUBE is progressive enhancement | "The end-goal is shipping as little CSS as possible—leaning heavily into progressive enhancement and modern techniques." | [CUBE CSS](https://piccalil.li/blog/cube-css/) |
| Safe value first | "By setting a reasonably sensible fallback value of `2rem` as the `font-size`, we are providing a decent minimum viable experience." | Complete CSS 02-8 |
| `@supports` ages fast | "CSS moves so fast now that your `@supports` query will be technical debt before you know it." | Complete CSS 02-8 |
| `a` goes, `button` acts | "if your user is supposed to go somewhere, use an `<a>` element. If something with JavaScript needs to happen, use a `<button>` element." | [Link or button](https://piccalil.li/blog/link-button/) |
| Focus is mandatory | "You must provide a focus style for interactive elements. There's no excuse to remove `outline`" | [How I build a button component](https://piccalil.li/blog/how-i-build-a-button-component/) |
| Hide visually, not from assistive tech | "If you hide an element with `display: none`, it can also hide it from assistive technology, such as screen readers." | [Visually hidden](https://piccalil.li/blog/visually-hidden/) |
| Current page in ARIA | "the aria-current='page' attribute which communicates the current page to assistive technology" | Complete CSS 05-11 |
| CMS content changes | "It might be right when we hand over, but that could change really quick!" | Complete CSS 02-2 |
| Defensive CSS | "Sure the assets are square, but the clients almost certainly won't maintain that. Defensive CSS!" | Complete CSS 05-9 |
| `:has()` for small tweaks | "I see `:has()` as being more useful for little tweaks more than anything" | [Little ways I use :has()](https://piccalil.li/blog/some-little-ways-im-using-css-has-in-the-real-world/) |

## Anti-patterns

| Anti-pattern | Quote | Source |
|---|---|---|
| Magic numbers for a static comp | "developers will be stuffing codebases full of magic numbers and hacks" | [Reality check 1](https://piccalil.li/blog/reality-check-1-building-out-a-furniture-site-from-dribbble/) |
| Rigid media-query layouts | "building rigid media query powered layouts was more harmful than helpful" | Complete CSS 02-4 |
| Fixed dimensions | "Tread really carefully when applying set width and height values in CSS though." | Complete CSS 05-9 |
| Viewport units for unknown conditions | "you don't know what viewport conditions the site will render in, so viewport units can cause havoc." | [Reality check 2](https://piccalil.li/blog/reality-check-2-building-out-a-fancy-404-page/) |
| Specificity wars | "Developers might try to alleviate this with extremely high specificity CSS, which as no surprise to many, breaks things further." | Complete CSS 01-1 |
| JS as a requirement | "When JS fails, the whole solution is dead." | [Checkmarks with PE](https://piccalil.li/blog/navigating-the-age-old-problem-of-checkmarks-in-ui-with-progressive-enhancement/) |

## Where this theme is stricter than the authors

The authors' own production CSS uses hand-written `clamp()` for one-off
sizes, `position: absolute` for decorations, literal art-direction values and
an `.active` class next to `aria-current`. This theme forbids them in blocks
on purpose (viewport-driven heights broke earlier client themes). Use the
alternatives in SKILL.md; do not argue the rule away with a quote.

Also seen in their current sites and allowed here when needed: named
container queries that re-set composition variables, theming by re-mapping
tokens on a `data-*` attribute, motion as an opt-in under
`prefers-reduced-motion: no-preference`, `!important` only inside
`@media (forced-colors: active)`.
