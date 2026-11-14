// Roadmap generation.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readJson } from './json-text.ts';

export type RoadmapRow = { task: string; line: string };
const roadmapTask = z.object({
  id: z.string(),
  status: z.string().optional(),
  priority: z.number().optional(),
  title: z.string().optional(),
  body: z.array(z.string()).optional(),
});
export type RoadmapTask = z.infer<typeof roadmapTask>;

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
    .map((name) =>
      roadmapTask.parse(readJson(readFileSync(join(directory, name), 'utf8'))),
    );
}

export function taskStatus(root: string, task: string): string | undefined {
  const path = join(root, 'tasks', `${task}.json`);
  if (!existsSync(path)) return undefined;
  return roadmapTask
    .pick({ status: true })
    .parse(readJson(readFileSync(path, 'utf8'))).status;
}
