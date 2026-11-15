# Process sources

The procedure adapts Andy Bell's Complete CSS course (a human working with a
designer) to an agent building this theme. "Complete CSS mm-n" is module and
lesson of [piccalil.li/complete-css](https://piccalil.li/complete-css);
modules: 02 Principles, 03 Planning and feedback, 04 Design prototyping, 05
Core build, 06 Flair pass, 07 Page compositions, 08 Wrapping up. Quotes are
verbatim.

| Step | Quote | Source |
|---|---|---|
| 1 Scope | "I would create a ticket, outlining the problems, instead of immediately making changes outside the scope of work." | [While you're fixing the fun stuff](https://piccalil.li/blog/while-youre-fixing-the-fun-stuff-fix-the-important-stuff-too/) |
| 1 Icebox | "Let’s stick that one in the Icebox for now, so that we can come back to it later" | Complete CSS 08-1 |
| 2 Read first | "Don't dive head-first into the code" | Complete CSS 03-1 |
| 2 Simplify | "there's a benefit to finding complexities and trying to simplify them in order to keep a project moving" | Complete CSS 03-1 |
| 3 Feedback | "make rough annotations on images and describe the problem in detail" | Complete CSS 03-2 |
| 3 Problems, not opinions | "Opinions won't get you there, but clearly articulating problems will." | Complete CSS 03-2 |
| 3 Tone | "Absolutely never make it personal." | Complete CSS 02-1 |
| 3 Offer | "How about we tweak this stuff in the browser together?" | Complete CSS 03-2 |
| 4 Sketch-up | "We don’t want to jump straight into code at this point." | Complete CSS 03-3 |
| 4 Fast | "If you get hung up on making stuff look pretty, you’re not thinking about the right stuff at this point." | Complete CSS 03-3 |
| 4 Legend | "Red is for wrappers/containers, blue is for flexbox layouts and green is for grid layouts." | Complete CSS 03-3 |
| 2 Small viewports | "we need some small viewport designs — AKA mobile designs" | Complete CSS 03-6 |
| 5 Scale | "don't get hung up on that, and instead, focus on consistency" | Complete CSS 03-7 |
| 6 Passes | "I like to break a build into at least two passes: a core build and a flare pass." | Complete CSS 03-8 |
| 6 Core | "In this pass, I focus on the system." | Complete CSS 03-8 |
| 6 Flair | "Anything that felt like it was slowing me down in the core build" | Complete CSS 03-8 |
| 6 Backlog | "It’s at this point in the project that I would create a backlog of tasks for each element on the page." | Complete CSS 03-8 |
| 6 Keep planning | "Take a step back at all points in the project to do some non-code planning." | Complete CSS 03-8 |
| 7 Prototype | "these prototypes are not pixel perfect and they certainly should not find themselves in production code. Rather, they are quick and rough." | Complete CSS 04-1 |
| 7 Still semantic | "it's important to still use semantic HTML even with a disposable prototype" | Complete CSS 04-2 |
| 8 Small pieces | "I'm building in small pieces and in two phases: a core build and a flair pass." | Complete CSS 05-1 |
| 8 Refactor later | "quickly add a task in a refactor backlog then carry on as I was doing" | Complete CSS 05-17 |
| 9 PE in flair | "I put most of the progressive enhancement work into the flair pass, building on the minimum viable experience." | Complete CSS 05-1 |
| 9 Freedom | "let designers be free creatively and then work with them to simplify elements if needed." | Complete CSS 06-2 |
| 10 Composition | "We’re not writing CSS here, instead, we’re putting markup together." | Complete CSS 07-1 |
| 11 Snags | "don't take snags personally" | Complete CSS 07-2 |
| 11 Cost | "clearly articulate how much time it will probably take. Time is money!" | Complete CSS 07-2 |
| 12 Document | "write documentation both in the pattern library/design system and also, right at the top of the code file." | Complete CSS 08-2 |

## Mapping to this theme

| Course concept | Here |
|---|---|
| Pattern library component | `Komponenty` group field + `components/<name>/template.php` + `blocks/<name>.css` (acf-component) |
| Page composition | rows of the `flexible_page` Flexible Content field |
| Design tokens from the comp | `src/design-tokens/*.json` (cube-css, references/tokens.md) |
| Integration with a CMS | already done by the allowlist renderer; editors fill content, never looks |
| Designer | the operator, who relays to the client's designer |
