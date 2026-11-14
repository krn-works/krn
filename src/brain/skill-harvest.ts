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
