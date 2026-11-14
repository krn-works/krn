// Generates docs/program/roadmap.md from the open tasks in tasks/ (logic: src/repo/roadmap.ts).
// Usage: roadmap-prune.ts [--check] [repository-root]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateRoadmap,
  readTasks,
  roadmapRows,
} from '../../src/repo/roadmap.ts';

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage = 'usage: roadmap-prune.ts [--check] [repository-root]';
  const check = args.includes('--check');
  const rest = args.filter((arg) => arg !== '--check');
  const unknown = rest.find((arg) => arg.startsWith('-'));
  if (unknown || rest.length > 1) {
    console.error(
      `roadmap-prune: ${unknown ? `unknown option ${unknown}` : 'too many arguments'}\n${usage}`,
    );
    process.exit(64);
  }
  const root = rest[0] ?? process.cwd();
  const path = join(root, 'docs/program/roadmap.md');
  const wanted = generateRoadmap(readTasks(root));
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (check) {
    if (current === wanted) console.log('roadmap-prune: in-sync');
    else {
      console.error(
        'roadmap-prune: out of sync with tasks/; run node scripts/claude/roadmap-prune.ts',
      );
      process.exit(1);
    }
  } else {
    if (current !== wanted) writeFileSync(path, wanted);
    console.log(
      `roadmap-prune: ${current === wanted ? 'unchanged' : 'regenerated'}, ${roadmapRows(wanted).length} open`,
    );
  }
}
