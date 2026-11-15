// Refreshes the site skills KRN installs into WordPress and frontend repositories from their one source:
// a commit of the boilerplate repository. Usage: node scripts/sync-site-skills.ts <repo> [<commit>].
// Every file under .agents/skills at that commit is copied whole; nothing is edited by hand.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(
  new URL('../src/adopt/site-skills/', import.meta.url),
);
const [repo, ref = 'HEAD'] = process.argv.slice(2);
if (repo === undefined) {
  console.error('usage: sync-site-skills.ts <boilerplate repo> [<commit>]');
  process.exit(64);
}
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const commit = git('rev-parse', `${ref}^{commit}`).trim();
const files = git('ls-tree', '-r', '--name-only', commit, '.agents/skills/')
  .split('\n')
  .filter((file) => file !== '');

for (const file of files) {
  const name = file.replace('.agents/skills/', '');
  rmSync(join(target, name.split('/')[0] as string), {
    recursive: true,
    force: true,
  });
}
for (const file of files) {
  const out = join(target, file.replace('.agents/skills/', ''));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, git('show', `${commit}:${file}`));
}
writeFileSync(
  join(target, 'source.json'),
  `${JSON.stringify({ repository: 'boilerplate-2026', path: '.agents/skills', commit }, null, 2)}\n`,
);
console.log(`site skills: ${files.length} files from ${commit}`);
