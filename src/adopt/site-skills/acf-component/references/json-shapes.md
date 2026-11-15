# Shapes for a new component

Example: the theme's FAQ section (`faq`), a Text intro and a repeater of
question/answer pairs, as shipped. Copy the shape, not the content.

## 1. Component group in `Komponenty`

Append to `fields` of `acf-json/group_rekurencja_components.json`:

```json
{
  "key": "field_rekurencja_component_faq",
  "label": "Pytania i odpowiedzi",
  "name": "faq",
  "type": "group",
  "layout": "block",
  "sub_fields": [
    {
      "key": "field_rekurencja_faq_text_component",
      "label": "Tekst",
      "name": "text_component",
      "type": "clone",
      "clone": [
        "field_rekurencja_component_text"
      ],
      "display": "seamless",
      "layout": "block",
      "prefix_label": 0,
      "prefix_name": 0
    },
    {
      "key": "field_rekurencja_faq_items",
      "label": "Pytania",
      "name": "items",
      "type": "repeater",
      "instructions": "Pytanie bez odpowiedzi nie pojawi się na stronie.",
      "layout": "block",
      "button_label": "Dodaj pytanie",
      "collapsed": "field_rekurencja_faq_question",
      "min": 0,
      "max": 0,
      "sub_fields": [
        {
          "key": "field_rekurencja_faq_question",
          "label": "Pytanie",
          "name": "question",
          "type": "text",
          "required": 0
        },
        {
          "key": "field_rekurencja_faq_answer",
          "label": "Odpowiedź",
          "name": "answer",
          "type": "wysiwyg",
          "required": 0,
          "tabs": "visual",
          "toolbar": "rekurencja",
          "media_upload": 0,
          "delay": 1
        }
      ]
    }
  ]
}
```

`collapsed` shows each row's question as its title when folded,
`instructions` tells the editor what the template skips, and `"delay": 1`
loads the WYSIWYG only when the editor clicks it, which keeps long repeaters
fast.

The seamless clone of `field_rekurencja_component_text` puts the Text fields
under the key `text` (the cloned field's name), so the template reads
`$faq['text']`.

## 2. Layout in `flexible_page`

Add to `fields[0].layouts` of `acf-json/group_rekurencja_flexible_page.json`:

```json
"layout_rekurencja_page_faq": {
  "key": "layout_rekurencja_page_faq",
  "name": "faq",
  "label": "Pytania i odpowiedzi",
  "display": "block",
  "sub_fields": [
    {
      "key": "field_rekurencja_page_faq_component",
      "label": "Pytania i odpowiedzi",
      "name": "faq_component",
      "type": "clone",
      "clone": ["field_rekurencja_component_faq"],
      "display": "seamless",
      "layout": "block",
      "prefix_label": 0,
      "prefix_name": 0
    }
  ],
  "min": "",
  "max": ""
}
```

Then set `"modified"` of both groups to the output of `date +%s`.

## 3. Allowlist

`inc/flexible-content-layouts.php`, same order as the layouts:

```php
'faq' => 'components/faq/template',
```

## 4. Template `components/faq/template.php`

```php
<?php

declare(strict_types=1);

/*
 * A Text intro over questions that open in place (<details>, no JavaScript).
 * A question without an answer is skipped; with no intro and no complete
 * question nothing renders.
 */

$faq = $args['faq'] ?? null;

if (!is_array($faq)) {
    return;
}

$text = $faq['text'] ?? null;
$has_text =
    is_array($text)
    && (
        trim((string) ($text['eyebrow'] ?? '')) !== ''
        || trim((string) ($text['heading'] ?? '')) !== ''
        || trim(wp_strip_all_tags((string) ($text['content'] ?? ''))) !== ''
        || is_array($text['buttons']['items'] ?? null)
        && $text['buttons']['items'] !== []
    );

$questions = [];

foreach (is_array($faq['items'] ?? null) ? $faq['items'] : [] as $item) {
    $question = trim((string) ($item['question'] ?? ''));
    $answer = (string) ($item['answer'] ?? '');

    if ($question !== '' && trim(wp_strip_all_tags($answer)) !== '') {
        $questions[] = ['question' => $question, 'answer' => $answer];
    }
}

if (!$has_text && $questions === []) {
    return;
}
?>
<div class="faq region">
    <div class="wrapper flow">
        <?php if ($has_text): ?>
            <?php get_template_part('components/text/template', null, ['text' => $text, 'profile' => 'section']); ?>
        <?php endif; ?>
        <?php if ($questions !== []): ?>
            <div class="faq__list">
                <?php foreach ($questions as $item): ?>
                    <details class="faq__item region flow">
                        <summary><?php echo esc_html($item['question']); ?></summary>
                        <div class="prose flow"><?php echo wp_kses_post($item['answer']); ?></div>
                    </details>
                <?php endforeach; ?>
            </div>
        <?php endif; ?>
    </div>
</div>
```

Semantic HTML first (`<details>` needs no JavaScript). Empty fields render
nothing rather than empty wrappers.

## 5. Block `src/css/blocks/faq.css`

```css
/*
FAQ BLOCK
Questions under a Text intro, divided by rules. Section padding and the room
around each question come from region; spacing from flow.
*/
.faq {
  --flow-space: var(--space-l);
}

.faq__list {
  border-block-start: var(--stroke) solid var(--color-dark);
  max-inline-size: var(--measure);
}

.faq__item {
  --flow-space: var(--space-xs);
  --region-space: var(--space-s);

  border-block-end: var(--stroke) solid var(--color-dark);
}

.faq__item > summary {
  cursor: pointer;
  font-size: var(--text-size-lede);
  font-weight: var(--font-weight-bold);
  line-height: var(--leading-fine);
}
```

Import it in `src/css/main.css` between the other blocks, alphabetically:
`@import './blocks/faq.css';`.

## Choice fields

A `select`/`radio`/`button_group`/`checkbox`/`color_picker`/`range` field fails
`check:acf` unless `choiceFields` in `tools/acf-validate.mjs` lists its key
(without `field_rekurencja_`) with the content reason, for example
`['media_content_position', 'reading order of photo and text']`. A visual
preference is not a reason; give the calling component a profile instead.

## Polish labels

`check:acf` rejects editor-visible strings (`label`, `instructions`,
`button_label`, `placeholder`, `title`, `description`, `choices` values)
that match the word list `englishWords` in `tools/acf-validate.mjs`: `the and
of to for with add choose use this button buttons image heading body content
left right before after center start end page component optionally`, whole
words, any case. Some are Polish too (`to`): rephrase (`jest`, `ten`)
instead of weakening the list.
Keep `name` in English (`items`, `question`), everything the editor reads in
Polish (`Pytania`, `Dodaj pytanie`).
