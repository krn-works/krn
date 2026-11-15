// Offline replay of a lane-brief proposal over the recorded FR-40 lanes (no model runs):
// `node evals/fr40/replay-proposal.ts <failing-task-id> [--arm A|B]` proposes one edit from that
// recorded failing lane and prints the before/after verdict that gates its acceptance.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  proposeEdit,
  type RecordedLane,
  renderVerdict,
  replayProposal,
} from '../../src/brain/lane-proposal.ts';
import { BUDGET, parseRecords } from '../../src/brain/packet.ts';
import { BASE_DATE } from './tasks.ts';

const here = new URL('./', import.meta.url);
const json = (path: string) =>
  JSON.parse(readFileSync(new URL(path, here), 'utf8'));

/** The worker rule each convention template is taught by (ids of records.json). */
export const RULE: Readonly<Record<string, string>> = {
  'commit-title-id': 'r-commit-title-id',
  trailer: 'r-trailer',
  'agent-state': 'r-agent-state',
  'tracker-untouched': 'r-tracker-owner',
  'core-imports': 'r-core-imports',
  'role-names': 'r-role-names',
  'biome-clean': 'r-biome-clean',
};

type Task = { id: string; template: string; prompt: string };

/** Every recorded lane of the Claude campaign joined with its task and the packet it carried. */
export function recordedLanes(
  root = 'results-lanes/fr40/runs/',
): RecordedLane[] {
  const tasks = new Map<string, Task>(
    (json('tasks.json') as Task[]).map((task) => [task.id, task]),
  );
  const material = json('material.json') as Record<string, { packet: string }>;
  const lanes: RecordedLane[] = [];
  for (const run of readdirSync(new URL(root, here))) {
    const score = json(`${root}${run}/score.json`);
    const task = tasks.get(score.task);
    if (task === undefined) continue;
    lanes.push({
      task: task.id,
      arm: score.arm,
      template: task.template,
      rule: RULE[task.template] ?? `r-${task.template}`,
      brief: `${task.prompt.trim()}\n`,
      passed: score.status === 'pass',
      reason: score.reason,
      packet: score.arm === 'B' ? (material[task.id]?.packet ?? '') : '',
      asOf: BASE_DATE,
      budget: BUDGET,
    });
  }
  return lanes.sort((a, b) =>
    `${a.task}${a.arm}`.localeCompare(`${b.task}${b.arm}`),
  );
}

export function replayFailing(task: string, arm: 'A' | 'B'): string {
  const lanes = recordedLanes();
  const records = parseRecords(json('records.json'));
  const failing = lanes.find(
    (l) => l.task === task && l.arm === arm && !l.passed,
  );
  if (failing === undefined)
    throw new Error(`no recorded failing lane ${task} arm ${arm}`);
  const proposal = proposeEdit(failing, records);
  if (proposal === null) throw new Error('lane did not fail');
  return renderVerdict(proposal, replayProposal(proposal, records, lanes));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [task, flag, arm] = process.argv.slice(2);
  if (task === undefined) {
    process.stderr.write(
      'usage: replay-proposal.ts <failing-task-id> [--arm A|B]\n',
    );
    process.exit(64);
  }
  process.stdout.write(
    `${replayFailing(task, flag === '--arm' && arm === 'B' ? 'B' : 'A')}\n`,
  );
}
