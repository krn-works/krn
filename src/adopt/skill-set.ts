// The one owner of which skills a repository gets: the core skills every repository gets, plus the
// one stack skill its marker files select. Only skills that exist in the installer source are named.
import { firstTestStack } from '../brain/first-test.ts';

/** Skills every adopted repository gets, whatever its stack. */
const CORE = ['delivery-lead', 'delivery-retro'] as const;

/** The stack skill a repository stack selects; a stack without one gets core skills only. */
const STACK_SKILL = {
  wordpress: 'wordpress',
  php: 'php',
  rust: 'rust',
  go: 'go',
  python: 'python',
  npm: 'typescript',
  static: 'frontend',
} as const;

/** The skill names to install for a repository root: core plus its stack skill, limited to `available`. */
export function skillSet(root: string, available: readonly string[]): string[] {
  const wanted: string[] = [...CORE, STACK_SKILL[firstTestStack(root)]];
  return wanted.filter((name) => available.includes(name));
}
