// The brief-only clause text of arm PC: what `krn lane brief` appends to a task, built from the task's own words.
// Usage: node evals/d23/clauses.ts <task text file>   prints the clause section, or nothing when the body states under two clauses.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clauseSection } from '../../src/brain/acceptance-clauses.ts';
import { statedBody } from '../../src/cli/lane-brief.ts';

const INTERFACE_MARK = '\n\nInterface the acceptance tests use';

/** The clause section for a replay task text; the interface paragraph the replay appends is not part of the brief's words. */
export function clausesFromBrief(taskText: string): string {
  const cut = taskText.indexOf(INTERFACE_MARK);
  const brief = cut === -1 ? taskText : taskText.slice(0, cut);
  return clauseSection(statedBody(brief));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: clauses.ts <task text file>\n');
    process.exit(64);
  }
  process.stdout.write(`${clausesFromBrief(readFileSync(file, 'utf8'))}\n`);
}
