// Removes the rows of docs/program/roadmap.md whose task is no longer open.
// Lanes close tasks without touching the roadmap; the lead runs this once in
// its own slice, so parallel lanes never rebase the table onto each other
// (two lanes deleting adjacent rows conflict in git even with stable ids).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type RoadmapRow = { id: string; task: string; line: string };

const rowPattern = /^\| (R\d+) \|.*\| (t-[a-z0-9]+) \|$/u;

export function roadmapRows(text: string): RoadmapRow[] {
  const rows: RoadmapRow[] = [];
  for (const line of text.split('\n')) {
    const match = rowPattern.exec(line);
    if (match?.[1] && match[2])
      rows.push({ id: match[1], task: match[2], line });
  }
  return rows;
}

// Returns the roadmap without rows whose task status is not "open".
export function pruneRoadmap(
  text: string,
  status: (task: string) => string | undefined,
): { text: string; removed: RoadmapRow[] } {
  const removed = roadmapRows(text).filter(
    (row) => status(row.task) !== 'open',
  );
  const drop = new Set(removed.map((row) => row.line));
  return {
    text: text
      .split('\n')
      .filter((line) => !drop.has(line))
      .join('\n'),
    removed,
  };
}

export function taskStatus(root: string, task: string): string | undefined {
  const path = join(root, 'tasks', `${task}.json`);
  if (!existsSync(path)) return undefined;
  return (JSON.parse(readFileSync(path, 'utf8')) as { status?: string }).status;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage = 'usage: roadmap-prune.ts [repository-root]';
  const unknown = args.find((arg) => arg.startsWith('-'));
  if (unknown || args.length > 1) {
    console.error(
      `roadmap-prune: ${unknown ? `unknown option ${unknown}` : 'too many arguments'}\n${usage}`,
    );
    process.exit(64);
  }
  const root = args[0] ?? process.cwd();
  const path = join(root, 'docs/program/roadmap.md');
  const result = pruneRoadmap(readFileSync(path, 'utf8'), (task) =>
    taskStatus(root, task),
  );
  if (result.removed.length > 0) writeFileSync(path, result.text);
  const ids = result.removed.map((row) => `${row.id} (${row.task})`);
  console.log(
    `roadmap-prune: removed ${ids.length}${ids.length ? `: ${ids.join(', ')}` : ''}`,
  );
}
