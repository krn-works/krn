// The one owner of which skills a repository gets: the core skills every repository gets, plus the
// site skill (WordPress, frontend) its marker files select. A language gets no prose skill: its
// conventions are stack-tagged records the brain serves at the moment of need (north-star item 2).
// Only skills that exist in the installer source are named.
import { type FirstTestStack, firstTestStack } from '../brain/first-test.ts';

/** Skills every adopted repository gets, whatever its stack. */
const CORE = ['delivery-lead', 'delivery-retro'] as const;

/** The site skill a repository stack selects; any other stack gets core skills only. */
const SITE_SKILL: Partial<Record<FirstTestStack, string>> = {
  wordpress: 'wordpress',
  static: 'frontend',
};

/** The skill names to install for a repository root: core plus its site skill, limited to `available`. */
export function skillSet(root: string, available: readonly string[]): string[] {
  const site = SITE_SKILL[firstTestStack(root)];
  const wanted: string[] = site === undefined ? [...CORE] : [...CORE, site];
  return wanted.filter((name) => available.includes(name));
}
