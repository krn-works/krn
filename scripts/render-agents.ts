// Writes or checks AGENTS.md from spec/rules.json (logic: src/repo/agents-render.ts). ADR 0001.
import { readFile, writeFile } from 'node:fs/promises';
import { checkRegistry, loadRules, render } from '../src/repo/agents-render.ts';

const root = new URL('../', import.meta.url);

if (import.meta.main) {
  const rules = await loadRules(root);
  const expected = render(rules);
  const checkOnly = process.argv.includes('--check');
  const write = process.argv.includes('--write');
  if (checkOnly === write) {
    process.stderr.write('Choose exactly one of --check or --write.\n');
    process.exitCode = 2;
  } else {
    const errors = await checkRegistry(root, rules);
    if (errors.length) {
      process.stderr.write(`${errors.join('\n')}\n`);
      process.exitCode = 1;
    } else if (checkOnly) {
      const actual = await readFile(new URL('AGENTS.md', root), 'utf8').catch(
        () => '',
      );
      if (actual !== expected) {
        process.stderr.write(
          'AGENTS.md is stale; run npm run render:agents.\n',
        );
        process.exitCode = 1;
      }
    } else {
      await writeFile(new URL('AGENTS.md', root), expected);
    }
  }
}
