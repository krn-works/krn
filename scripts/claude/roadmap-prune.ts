// Generates docs/program/roadmap.md from the open tasks in tasks/: ranked by
// priority then id, one row per task with its title and Why line. No one edits
// the table by hand, so parallel lanes never conflict on it; closing a task
// removes its row at the next generation.
// Usage: roadmap-prune.ts [--check] [repository-root]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type RoadmapRow = { task: string; line: string };
export type RoadmapTask = {
  id: string;
  status?: string;
  priority?: number;
  title?: string;
  body?: string[];
};

const rowPattern = /^\| (t-[a-z0-9]+) \|.*\|$/u;

export function roadmapRows(text: string): RoadmapRow[] {
  const rows: RoadmapRow[] = [];
  for (const line of text.split('\n')) {
    const match = rowPattern.exec(line);
    if (match?.[1]) rows.push({ task: match[1], line });
  }
  return rows;
}

const cell = (text: string, limit = 200) => {
  const flat = text.replace(/\s+/gu, ' ').replace(/\|/gu, '/').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

// The evidence of a task is the text after "Why:" up to the end of that line.
export function evidenceLine(task: RoadmapTask): string {
  const why = /^Why:[ \t]*(.*)$/mu.exec((task.body ?? []).join('\n'));
  return cell(why?.[1] ?? '');
}

const preamble = `# Improvement roadmap

Generated from the open tasks in \`tasks/\` by \`node scripts/claude/roadmap-prune.ts\`; do not edit by hand. Rank is the task priority (1 first), then the task id. Change the ranking, title or evidence by editing the task (\`krn task\`), and run the script in the same change; \`--check\` prints \`in-sync\` when the file matches the tasks. The handoff's \`## Resume\` carries \`- Roadmap: <task ids changed>\` or \`- Roadmap: unchanged (<reason>)\`; \`scripts/claude/handoff-requests.ts\` refuses a handoff without that line or naming an id with no task file. The proactive refill scan runs \`krn-radar\` and files each pattern as a task, which then appears here.

| Task | Priority | Opportunity | Evidence |
|---|---|---|---|
`;

export function generateRoadmap(tasks: RoadmapTask[]): string {
  const open = tasks
    .filter((task) => task.status === 'open')
    .sort(
      (a, b) =>
        (a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id),
    );
  const rows = open.map(
    (task) =>
      `| ${task.id} | ${task.priority ?? ''} | ${cell(task.title ?? '')} | ${evidenceLine(task)} |\n`,
  );
  return preamble + rows.join('');
}

export function readTasks(root: string): RoadmapTask[] {
  const directory = join(root, 'tasks');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^t-[a-z0-9]+\.json$/u.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')));
}

export function taskStatus(root: string, task: string): string | undefined {
  const path = join(root, 'tasks', `${task}.json`);
  if (!existsSync(path)) return undefined;
  return (JSON.parse(readFileSync(path, 'utf8')) as { status?: string }).status;
}

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
