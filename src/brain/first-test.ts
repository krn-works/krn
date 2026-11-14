// First-test recipes (the worker packet of a bootstrap lane): per detected stack, how to add the first
// real test and wire krn.json `test`. The bootstrap proof (lane-run) accepts only a test that goes red
// when a production line is deleted, so every recipe tests a pure function, never a smoke over nothing.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type FirstTestStack = 'wordpress' | 'php' | 'npm' | 'static';

/** The stack of a repository root by its marker files; WordPress wins over plain PHP, PHP over npm. */
export function firstTestStack(root: string): FirstTestStack {
  const has = (name: string) => existsSync(join(root, name));
  const php =
    has('composer.json') ||
    readdirSync(root).some((name) => name.endsWith('.php'));
  if (
    has('wp-content') ||
    has('wp-config.php') ||
    has('functions.php') ||
    has('wp-cli.yml') ||
    has('style.css')
  )
    return 'wordpress';
  if (php) return 'php';
  return has('package.json') ? 'npm' : 'static';
}

const NO_PHP_SEAM =
  'Pick one pure function (no WordPress calls, no globals, no I/O); if every function calls WordPress, move one computation into a plain function in its own file with no WordPress call.';

const RECIPES: Record<FirstTestStack, string> = {
  php: [
    'First test, PHP: pick one pure function; write tests/SmokeTest.php that requires its file and asserts its result for one hand-written input.',
    'With composer: `composer require --dev phpunit/phpunit` (or pest when already present), then krn.json "test": "vendor/bin/phpunit tests".',
    'Without composer or network: tests/smoke.php that requires the file and calls `exit(f(2, 3) === 5 ? 0 : 1)`, krn.json "test": "php tests/smoke.php".',
    'Cheaper checks first when the test cannot run yet: `php -l` on changed files, PHPStan level 0 with a baseline (no new errors).',
  ].join(' '),
  wordpress: [
    `First test, WordPress: unit seam without wp-env or a database. ${NO_PHP_SEAM}`,
    'Write tests/smoke.php (or a phpunit test with no WordPress bootstrap) that requires only that file and asserts its result for one hand-written input; krn.json "test": "php tests/smoke.php" or "vendor/bin/phpunit tests".',
    'Do not require wp-load.php or start wp-env. Ladder when a function needs WordPress: `php -l` on changed files, PHPStan level 0 with szepeviktor/phpstan-wordpress and --generate-baseline, a Playwright smoke (200, no "Fatal error" or "Warning:" on sitemap URLs), then PHPUnit via `wp scaffold plugin-tests` per touched function.',
  ].join(' '),
  npm: [
    'First test, npm: node:test over a pure module or the build output.',
    'Write test/<module>.test.mjs with `import test from "node:test"; import assert from "node:assert/strict";`, import one pure function (or read a file from the build output) and assert its result for one hand-written input.',
    'krn.json "test": "node --test" (and "scripts.test" in package.json when absent).',
  ].join(' '),
  static: [
    'First test, static site: node:test reads one built or source HTML/CSS file and asserts a fact the page must keep (a title, a link target, a required element).',
    'krn.json "test": "node --test"; keep the assertion on content that production code or markup produces, so deleting its line fails the test.',
  ].join(' '),
};

/** The recipe text for a stack. */
export const firstTestRecipe = (stack: FirstTestStack): string =>
  RECIPES[stack];

/** The packet section a bootstrap lane gets: the recipe of the repository's own stack. */
export function firstTestSection(root: string): string {
  return `First-test recipe (${firstTestStack(root)}): ${firstTestRecipe(firstTestStack(root))}`;
}
