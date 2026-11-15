// Harvest of a repository's agent skills (`.claude/skills/<name>/SKILL.md`) into trial pack
// records: one record per skill, its frontmatter description as the statement, gated by the
// repository kind (`applies.needs`) and the files it concerns (`applies.paths`). Pure: the caller
// reads the skill files and the commit they were last changed in; nothing here writes or runs git.
import { RecordSchema, type UnifiedRecord } from './record.ts';
import { StandardsDataError } from './standards.ts';

export type SkillSource = {
  /** The skill file path inside its repository, `.claude/skills/<name>/SKILL.md`. */
  readonly path: string;
  readonly text: string;
};

/** How a known skill enters the pack: the repository kind it needs, its area word and the files it concerns. */
type SkillPlacement = {
  readonly type: 'standard' | 'recipe';
  readonly area: 'frontend' | 'wordpress';
  readonly paths: readonly string[];
};

const THEME = 'web/app/themes/**';

/** The placement of each skill of the boilerplate frontend and WordPress standard; a skill not listed here is refused. */
export const SKILL_PLACEMENT: Readonly<Record<string, SkillPlacement>> = {
  'acf-component': {
    type: 'recipe',
    area: 'wordpress',
    paths: ['**/*.php', '**/acf-json/*.json', THEME],
  },
  'cube-css': {
    type: 'standard',
    area: 'frontend',
    paths: ['**/*.css', THEME],
  },
  'cube-review': {
    type: 'recipe',
    area: 'frontend',
    paths: ['**/*.css', '**/*.php', '**/acf-json/*.json'],
  },
  'design-to-build': {
    type: 'recipe',
    area: 'frontend',
    paths: ['**/*.css', '**/*.php', THEME],
  },
  'plesk-deploy': {
    type: 'recipe',
    area: 'wordpress',
    paths: ['.github/workflows/*.yml', 'deploy/**', 'composer.json'],
  },
  'wp-runtime': {
    type: 'recipe',
    area: 'wordpress',
    paths: ['mise.toml', '.ddev/**', '**/*.php', 'vite.config.*'],
  },
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

/** The `key: value` lines of a skill's frontmatter. */
function frontmatter(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const block = FRONTMATTER.exec(text)?.[1] ?? '';
  for (const line of block.split(/\r?\n/u)) {
    const at = line.indexOf(':');
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return fields;
}

/**
 * One trial record per skill: `commit` and the skill path are its provenance, `recordedAt` its
 * dates. A skill without a name and description, or one the placement table does not know, is
 * refused with an error naming its path.
 */
export function harvestSkills(
  sources: readonly SkillSource[],
  commit: string,
  recordedAt: string,
  origin = 'boilerplate-2026',
): UnifiedRecord[] {
  return sources.map((source) => {
    const fields = frontmatter(source.text);
    const name = fields.get('name');
    const description = fields.get('description');
    if (name === undefined || description === undefined || description === '')
      throw new StandardsDataError(
        `${source.path}: frontmatter needs name and description`,
      );
    const placement = SKILL_PLACEMENT[name];
    if (placement === undefined)
      throw new StandardsDataError(
        `${source.path}: skill ${name} has no placement in SKILL_PLACEMENT`,
      );
    return RecordSchema.parse({
      id: `s-skill-${name}`,
      type: placement.type,
      area: placement.area,
      layer: 'universal',
      audience: 'worker',
      tier: 'finish',
      text: description,
      why: `Trial standard harvested read-only from the ${origin} skill ${name}.`,
      applies: {
        stacks: [],
        needs: [placement.area],
        paths: placement.paths,
        terms: [],
      },
      enforcement: { kind: 'advisory' },
      provenance: {
        origin: `${origin} ${source.path}`,
        evidence: [commit],
        proposals: [],
      },
      status: 'trial',
      recorded_at: recordedAt,
      valid_from: recordedAt,
      valid_to: null,
      supersedes: [],
    });
  });
}

/** One imperative rule of a skill, found in its text by `anchor` and placed by the scope it names. */
type SkillRule = {
  readonly id: string;
  readonly skill: string;
  /** A substring of the one source line the rule restates; the line number is the evidence. */
  readonly anchor: string;
  readonly text: string;
  readonly area: 'frontend' | 'wordpress' | 'node';
  readonly stacks: readonly string[];
  readonly needs: readonly string[];
  readonly paths: readonly string[];
};

const TS_FILES = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
const CSS = ['**/*.css', THEME];
const PHP = ['**/*.php', '**/acf-json/*.json'];

function rule(
  skill: string,
  area: SkillRule['area'],
  scope: Pick<SkillRule, 'stacks' | 'needs' | 'paths'>,
  rows: readonly (readonly [id: string, anchor: string, text: string])[],
): SkillRule[] {
  return rows.map(([id, anchor, text]) => ({
    id,
    skill,
    anchor,
    text,
    area,
    ...scope,
  }));
}

/** The origin label of the repository each rule's skill comes from. */
const RULE_ORIGIN: Readonly<Record<string, string>> = { typescript: 'krn' };

/** One short imperative sentence per rule, each scoped to the stack or files where the edit hook serves it. */
export const SKILL_RULES: readonly SkillRule[] = [
  ...rule(
    'typescript',
    'node',
    { stacks: ['node'], needs: [], paths: TS_FILES },
    [
      [
        's-ts-annotate-edge',
        'Infer inside, annotate at the edge.',
        'Annotate exported function parameters and let locals and non-contract return types infer.',
      ],
      [
        's-ts-parse-at-edge',
        'Parse at the edge.',
        'Take external input as unknown and parse it once with a zod schema, deriving the type with z.infer.',
      ],
      [
        's-ts-discriminated-unions',
        'Make invalid states unrepresentable.',
        'Model states as discriminated unions with an exhaustive never-checked switch, not bags of optional fields.',
      ],
      [
        's-ts-isolate-casts',
        'No `any`, no unsafe casts.',
        'Prefer unknown plus narrowing, and isolate a necessary cast or non-null assertion in the smallest scope with its runtime check.',
      ],
      [
        's-ts-narrow-exports',
        'Narrow exports.',
        'Export only what another module imports, use export type for types and write no export * barrel.',
      ],
      [
        's-ts-simple-types',
        'Simple types beat clever ones.',
        'Prefer a readable union or overload over conditional or mapped type machinery.',
      ],
      [
        's-ts-prove-types',
        'Prove it.',
        'Run the type check after any .ts change and prove a public type relationship with a ts-expect-error line or an assignability assertion.',
      ],
    ],
  ),
  ...rule(
    'cube-css',
    'frontend',
    { stacks: [], needs: ['frontend'], paths: CSS },
    [
      [
        's-css-token-values',
        'Every space, size, colour',
        'Take every space, size, colour, weight, radius and duration from a design token, never a hand-written value.',
      ],
      [
        's-css-no-clamp',
        'Fluid values come from the generated steps',
        'Take fluid values from the generated token steps and write no new clamp().',
      ],
      [
        's-css-specificity',
        'The block class is the only boost',
        'Raise specificity only with the block class: no id selector, no !important and no :is() boost.',
      ],
      [
        's-css-data-exception',
        'A variant is a `data-*`',
        'Express a variant as a data-* attribute with a finite value set, never as a BEM -- or is-/has- class.',
      ],
      [
        's-css-no-block-min-height',
        '| `min-height`, `min-block-size`',
        'Give a block no min-height: let height follow content and use .region for section padding.',
      ],
      [
        's-css-already-owned',
        '**Already owned.**',
        'Delete a declaration that a global, composition, token or utility already produces and set the composition variable instead.',
      ],
      [
        's-css-layer-owner',
        '**Layer.**',
        'Put each declaration in the layer that owns it: no colour in a composition, no layout in a utility, no component selector in globals.',
      ],
    ],
  ),
  ...rule(
    'acf-component',
    'wordpress',
    { stacks: [], needs: ['wordpress'], paths: PHP },
    [
      [
        's-acf-define-once',
        "A component's fields are defined **once**",
        "Define a component's fields once as a group field in the Komponenty group and clone it into each layout.",
      ],
      [
        's-acf-args-only',
        'Templates read only `$args`',
        'Read only $args in a component template and call no get_field() or get_sub_field().',
      ],
      [
        's-acf-layout-allowlist',
        'Layout name → template path only',
        'Map a layout name to its template only in the static allowlist inc/flexible-content-layouts.php, never from a database value.',
      ],
      [
        's-acf-content-not-looks',
        'Editors choose content, not looks',
        'Add no appearance field (size, colour, alignment, heading level) to an ACF group; the component sets its look with a profile.',
      ],
      [
        's-acf-modified-bump',
        'hand edit set',
        'After hand-editing acf-json set modified of each changed group to date +%s before running acf json sync.',
      ],
      [
        's-acf-empty-array',
        'An empty ACF repeater or image',
        'Test is_array() on an ACF repeater or image value, because empty comes back as false or an empty string.',
      ],
      [
        's-acf-keep-keys',
        'Change an existing key',
        'Never rename an existing ACF key: keys are stored identity and a rename needs a data migration.',
      ],
      [
        's-wp-escape-output',
        'Escape at the output boundary',
        'Escape every printed value at the output boundary with esc_html, esc_attr, esc_url or wp_kses_post.',
      ],
    ],
  ),
  ...rule(
    'wp-runtime',
    'wordpress',
    { stacks: [], needs: ['wordpress'], paths: ['mise.toml', '.ddev/**'] },
    [
      [
        's-wp-never-mutate-production',
        'Never mutate production',
        'Never mutate production, remote files, databases or credentials from the local runtime.',
      ],
    ],
  ),
  ...rule(
    'plesk-deploy',
    'wordpress',
    {
      stacks: [],
      needs: ['wordpress'],
      paths: ['.github/workflows/*.yml', 'deploy/**', 'config/release.php'],
    },
    [
      [
        's-deploy-tooling-pin',
        'Bump the SHA deliberately',
        "Bump the pinned release-tooling SHA only after reading the receiver's changes and updating receiver.php on every server.",
      ],
      [
        's-deploy-wpcli-core-path',
        'WP-CLI with `--path=…/web` never works',
        'Run WP-CLI against the Bedrock core directory web/wp, never --path=web.',
      ],
    ],
  ),
  ...rule(
    'cube-review',
    'frontend',
    { stacks: [], needs: ['frontend'], paths: [...CSS, ...PHP] },
    [
      [
        's-review-new-names',
        '**New names.**',
        'Name the consumer of each new token, variable, selector or field and the existing one it duplicates; a pixel-only addition is a finding.',
      ],
    ],
  ),
  ...rule(
    'design-to-build',
    'frontend',
    { stacks: [], needs: ['frontend'], paths: [...CSS, ...PHP] },
    [
      [
        's-design-scale-values',
        '**Scale.**',
        'Map design values to the nearest step of the token scale instead of chasing a pixel, and make a genuinely new value a token.',
      ],
    ],
  ),
];

/** The skill name of a `.../skills/<name>/SKILL.md` path. */
function skillName(path: string): string | undefined {
  return /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/u.exec(path)?.[1];
}

/**
 * The accepted, scoped rule records of the skills among `sources`: each one restates one source
 * line, cites it as `path:line` in its origin and names the stack or file globs where the edit hook serves it.
 * A rule whose anchor is no longer in its skill is refused with an error naming the path.
 */
export function harvestRules(
  sources: readonly SkillSource[],
  commit: string,
  recordedAt: string,
  origin = 'boilerplate-2026',
): UnifiedRecord[] {
  const records: UnifiedRecord[] = [];
  for (const source of sources) {
    const name = skillName(source.path);
    const lines = source.text.split(/\r?\n/u);
    for (const found of SKILL_RULES.filter((r) => r.skill === name)) {
      const at = lines.findIndex((line) => line.includes(found.anchor));
      if (at < 0)
        throw new StandardsDataError(
          `${source.path}: rule ${found.id} anchor ${JSON.stringify(found.anchor)} not found`,
        );
      const from = RULE_ORIGIN[found.skill] ?? origin;
      records.push(
        RecordSchema.parse({
          id: found.id,
          type: 'standard',
          area: found.area,
          audience: 'worker',
          tier: 'reflex',
          text: found.text,
          why: `Harvested from the ${from} skill ${found.skill} so a session meets it on the first edit of a matching file.`,
          applies: {
            stacks: found.stacks,
            needs: found.needs,
            paths: found.paths,
            terms: [],
          },
          enforcement: { kind: 'advisory' },
          provenance: {
            origin: `${from} ${source.path}:${at + 1}`,
            evidence: [commit],
            proposals: [],
          },
          status: 'accepted',
          recorded_at: recordedAt,
          valid_from: recordedAt,
          valid_to: null,
          supersedes: [],
        }),
      );
    }
  }
  return records;
}
