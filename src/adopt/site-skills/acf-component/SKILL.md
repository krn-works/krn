---
name: acf-component
description: Add or change a page component of this WordPress theme (ACF PRO Flexible Content layout, component field group, static PHP template, CUBE block). Use for any new page section, field, layout or component template; CSS rules live in cube-css.
---

# ACF component

Every page (`post_type == page`) is the Flexible Content field **Treść strony**
(`flexible_page`). There is no Gutenberg, ACF Blocks, `block.json`,
`theme.json` or page builder. A page without rows renders its title in
`.prose`. Theme: `web/app/themes/rekurencja-theme/`.

```text
acf-json → flexible_page row → static PHP allowlist
         → component record ($args) → components/<name>/template.php → CUBE block
```

## Contract

| Rule | Where | Check |
|---|---|---|
| A component's fields are defined **once**, as a `group` field in the disabled **Komponenty** group (`acf-json/group_rekurencja_components.json`) | acf-json | review (`check:acf` checks the clone target) |
| Each `flexible_page` layout opens with a **seamless clone** of a Components field (`check:acf`); keep it the only sub field, with `prefix_name: 0` (review) | `group_rekurencja_flexible_page.json` | `check:acf`, review |
| Layout name → template path only in `inc/flexible-content-layouts.php`; never a path from the database | allowlist | `check:acf` |
| Keys `group_rekurencja_*`, `field_rekurencja_*`, `layout_rekurencja_*`, unique, every clone resolves | acf-json | `check:acf` |
| Labels, instructions, button labels and choices in **Polish**; field `name` in English | acf-json | `check:acf` |
| Editors choose content, not looks: a choice field (`select`, `radio`, `button_group`, `checkbox`, `color_picker`, `range`) needs an entry with a reason in `choiceFields` of `tools/acf-validate.mjs` | acf-json | `check:acf` |
| WYSIWYG `toolbar` is the slug of a toolbar the theme registers: `"rekurencja"` (registered as `$toolbars['Rekurencja']` in `inc/flexible-content.php`, slugged lowercase) | acf-json | `check:acf` |
| Templates read only `$args`; no `get_field()`/`get_sub_field()` | template | review |
| Escape at the output boundary | template | `check:lint` (Mago `no-unescaped-output`) |
| Logic stays visible where it is used: the theme declares no named function (hooks take closures, the page loop lives in `page.php`) | theme PHP | `check:test` (`tests/components.test.mjs`) |
| A component whose fields are empty renders nothing: no empty `.region`, no empty `.frame` | template | `check:browser` (`content.<page>`) |
| Long words and bare URLs wrap: no block sets a width that a word can push past the viewport | CSS | `check:browser` (`stress.<page>@320` appends them to every text element) |

The loop in `page.php` calls
`get_template_part($template, null, [$layout => $row[$layout], 'layout' => $layout])`
with `$row = get_row(true)`. So the template of layout `faq` reads
`$args['faq']` (the component group's value) and `$args['layout']`.

## Text: content, not looks

`Text` holds content only: eyebrow, heading, body (WYSIWYG) and buttons. The
editor never picks size, colour, heading level or alignment. The component
that renders Text sets its look with a **profile**:

| Profile | Passed by | Heading | Tokens |
|---|---|---|---|
| `page` | Hero | `h1` | `--text-size-heading-1`, lede body, `--measure-compact` |
| `section` | Text layout, Media and content | `h2` | `--text-size-heading-2`, `--measure` |
| `compact` | Call to action | `h2` | `--text-size-heading-3`, `--measure-compact` |

`components/text/template.php` checks the profile against a PHP allowlist
(default `section`) and writes `data-text-profile`; `src/css/blocks/text.css`
maps it to tokens. A new look is a new profile in both files, never an editor
field.

Text wraps itself in `.region > .wrapper` only when `$args['layout']` is
`text` (its own layout). A component that renders Text inside its own
section passes the profile, not `layout`, or the section wraps twice.

## Template hygiene

A template reads top to bottom like the markup it prints: read `$args`,
derive plain `$has_*` booleans next to the fields they test, return early,
then HTML. Someone renaming a class or a field changes one file, never a
helper elsewhere.

```php
$text = $cta['text'] ?? null;
$has_text =
    is_array($text)
    && (
        trim((string) ($text['eyebrow'] ?? '')) !== ''
        || trim((string) ($text['heading'] ?? '')) !== ''
        || trim(wp_strip_all_tags((string) ($text['content'] ?? ''))) !== ''
        || is_array($text['buttons']['items'] ?? null)
        && $text['buttons']['items'] !== []
    );

if (!$has_text) {
    return;
}
```

- No helper "to avoid repetition" between templates: three visible copies
  of a five-line check beat one hidden function. Never name anything after
  the theme or the organisation.
- An empty ACF repeater or image comes back as `false` or `''`, not `[]`:
  test `is_array(...)`, never `!== []` alone; `empty()` is banned by Mago.
- Wrap in a composition only when it has something to lay out: Media + treść
  drops `sidebar` and `.frame` when one side is empty.

## Procedure

Add a component only when a real page needs it. Read one similar component
(`cta` is the smallest, `media-content` uses a composition exception) before
writing.

1. **Fields.** Add the component's `group` field to `Komponenty` with Polish
   labels; reuse `Text` and `Buttons` by seamless clone instead of new
   heading/body/button fields. Shapes: [references/json-shapes.md](references/json-shapes.md).
2. **Layout.** Add a layout to `flexible_page` that holds one seamless clone
   of that group.
3. **Allowlist.** Append `'<layout>' => 'components/<name>/template'` to
   `inc/flexible-content-layouts.php`. Until step 4 exists `check:acf`
   fails with "has no template"; that is expected.
4. **Template.** Add `components/<name>/template.php`: read
   `$args['<layout>']`, return early when it is not an array or every
   field is empty (see Template hygiene),
   escape every value (`esc_html`, `esc_attr`, `esc_url`, `wp_kses_post`;
   images through `wp_get_attachment_image()`). Render Text with
   `get_template_part('components/text/template', null, ['text' => …, 'profile' => '…'])`.
   Skeleton in [references/json-shapes.md](references/json-shapes.md).
5. **Block CSS.** Add `src/css/blocks/<name>.css` and import it in
   `src/css/main.css` (blocks section, alphabetical). Use the cube-css skill:
   `.region` + `.wrapper` for the section, compositions for layout, the block
   only sets tokens and composition variables.
6. **Sync.** Edit acf-json by hand in the file's own style (an editor or a
   string edit, not a JSON re-dump that reflows the whole file). After any
   hand edit set `"modified"` of every changed group to `date +%s`, then
   `ddev wp acf json sync --type=field-group`.
   Without the bump ACF reports "already in sync", the database keeps the old
   group, and the next save in wp-admin overwrites your JSON with the stale
   copy. Doctor's `wp.acf-sync` compares group contents with the database and
   fails on a missed step.
7. **Content.** Add a row on a local page so the browser gate renders the
   component: in wp-admin, or with a seed script in the ignored `.cache/`
   (inside the DDEV mount, unlike a scratchpad; `ddev exec wp eval "…"` breaks
   on `$`): `ddev wp eval-file .cache/seed.php`. Write the whole
   `flexible_page` with `update_field('field_rekurencja_flexible_page', $rows, $page_id)`;
   each row is `['acf_fc_layout' => '<layout>', '<group name>' => [<values>]]`
   and a seamless Text clone is the key `text` (not the clone field's
   `text_component`). Values: image = attachment ID, link =
   `['title' => …, 'url' => …, 'target' => '']`, repeater = list of rows.
   Read it back with `get_field()` and fail when the layouts differ.

## Verify

```bash
mise run fix                # Mago formats new PHP; check:lint fails until it has
mise run check:acf          # JSON, keys, clones, allowlist, Polish labels, choices, toolbars
mise run check:css          # block token discipline
mise run check:lint         # escaping, format
mise run doctor             # wp.acf-sync: database equals acf-json
mise run check              # every container-free gate
mise run check:browser      # with and without `mise run dev` running
```

`check:acf` proves the static contract only; editor save, panel UX and the
rendered result need doctor, wp-admin and `check:browser`. Report them
separately. A negative control is cheap: remove the allowlist entry and
`check:acf` must fail.

## Do not

- Add appearance fields (size, colour, alignment, heading level, spacing) or a
  choice without a content reason.
- Copy a field schema into a second group or layout; clone the component.
- Change an existing key: keys are stored identity in the database; a rename
  needs a data migration.
- Build template paths from `get_row_layout()` without the allowlist.
- Hide template logic in a helper function or name one after the theme.
- Put layout or spacing CSS in the template (`style=""`) or new classes
  without a consumer.
