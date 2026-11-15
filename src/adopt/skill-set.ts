// The one owner of which skills a repository gets: the core skills every repository gets, plus the
// site skills (WordPress, frontend) its marker files select. A language gets no prose skill: its
// conventions are stack-tagged records the brain serves at the moment of need (north-star item 2).
// Site skills come whole from one pinned commit of the boilerplate repository (site-skills/source.json).
// Only skills that exist in the installer source are named.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FirstTestStack, firstTestStack } from '../brain/first-test.ts';

/** Skills every adopted repository gets, whatever its stack. */
const CORE = ['delivery-lead', 'delivery-handoff', 'delivery-retro'] as const;

const FRONTEND = ['cube-css', 'cube-review', 'design-to-build'] as const;

/** The site skills a repository stack selects; any other stack gets core skills only. */
const SITE_SKILLS: Partial<Record<FirstTestStack, readonly string[]>> = {
  wordpress: [...FRONTEND, 'acf-component', 'wp-runtime'],
  static: FRONTEND,
};

/** The one skill that belongs only to a repository that deploys to Plesk. */
const PLESK_SKILL = 'plesk-deploy';

/** Where the installer holds the site skills, one directory each, beside the pin file. */
export const SITE_SKILLS_DIR = fileURLToPath(
  new URL('./site-skills/', import.meta.url),
);

/** Every site skill directory the installer can copy. */
export function siteSkillNames(): string[] {
  return readdirSync(SITE_SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** True when a workflow file of the repository names Plesk: its deploy goes to a Plesk server. */
export function deploysToPlesk(root: string): boolean {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((file) =>
    /plesk/iu.test(readFileSync(join(dir, file), 'utf8')),
  );
}

/** The skill names to install for a repository root: core plus its site skills, limited to `available`. */
export function skillSet(root: string, available: readonly string[]): string[] {
  const stack = firstTestStack(root);
  const site = SITE_SKILLS[stack] ?? [];
  const wanted: string[] = [...CORE, ...site];
  if (site.length > 0 && deploysToPlesk(root)) wanted.push(PLESK_SKILL);
  return wanted.filter((name) => available.includes(name));
}
