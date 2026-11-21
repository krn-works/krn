import { clauseSection, isBugBody } from '../brain/acceptance-clauses.ts';
import { firstTestSection } from '../brain/first-test.ts';
import { callSiteSweep, precedentSection } from '../brain/precedent.ts';
import { taskKey, taskQueryText } from '../brain/task-query.ts';
import {
  gatesBlock,
  heldOut,
  lanePacket,
  packetBrief,
} from '../brain/worker-packet.ts';
import { armOn, findContract } from '../repo/contract.ts';

/**
 * What a worker is told: the engineering it owes, not the gates around it. The CI Check on the PR
 * decides; the repository, not a task record or an earlier commit, is the truth.
 */
const SHARED_RULES = `Worker rules:
- Make the smallest change that does what the task asks. Delete before you add; reuse the module that already owns the concern instead of writing a parallel one; leave no export without a caller.
- Test behaviour through its public interface at the lowest layer that reproduces it. A defect fix carries the regression test that fails without it; a deletion or a refactor that keeps behaviour needs no new test, and no test ever asserts that something is absent.
- When the task names an input or output format (for example "unified diffs", "newline-separated lists", "JSON"), test it with the plainest hand-written example of that format, never only input your own code produced.
- A red test outranks tracker state and scope: if a named red test fails without a change outside Scope, edit that file and say so. Otherwise stay inside Scope and leave .agents/, .claude/, AGENTS.md, CLAUDE.md and tasks/ alone.
- Back every claim about an external system (a remote, a service, a CI run) with the command you ran and its exit code.
- Pass the choices the task left open to \`krn pr body --lane --assumptions <text>\` ('none' when it fixed everything).`;

/**
 * The worker rules for this repository: the closing check names the Stop script where the
 * repository ships it, else the repo contract's own commands, so a pytest repository on master
 * is never told to run npm.
 */
export function workerRules(
  repo: string,
  testFirst = process.env.KRN_TEST_FIRST !== '0' &&
    armOn(findContract(repo)?.contract, 'red-first'),
): string {
  const rules = baseWorkerRules(repo);
  return testFirst ? `${rules}\n- ${TEST_FIRST_RULE}` : rules;
}

/** On where the contract enables the red-first arm (KRN_TEST_FIRST=0 drops it). */
export const TEST_FIRST_RULE =
  'Test first: prove red at base. Before you change source, commit or at least write a test that fails against the base source and shows the defect or missing behavior; the PR then shows a changed test that fails at the base and passes on your commit. Characterization mode: when the task only adds tests for behaviour that already works and you change no source, a diff of test files alone passes when the new tests pass at the base and on your commit; any source change still needs a test that is red at the base.';

function baseWorkerRules(repo: string): string {
  const contract = findContract(repo)?.contract;
  const check =
    contract === undefined
      ? "the repository's tests"
      : `'${contract.fast ?? contract.test}'`;
  return `${SHARED_RULES}\n- Before you ship, run ${check} once and fix what it reports; changes target branch '${contract?.base ?? 'main'}' and the CI Check on the PR runs the rest. If you cannot finish, push your branch and say in your final reply what blocks you.`;
}

/** The closure line for a named task: the lane closes its own record in its own PR, so the Ticket trailer passes the CI task check. */
export function closureRule(task: string): string {
  return `- Task record: this PR completes ${task}. Use the trailer \`Ticket: ${task}\` and, from inside your worktree, run \`bin/krn task close ${task} --as done --note <what you proved>\` so the closed record ships in your PR. If the task stays open, use \`Refs: ${task}\` and do not close it. Edit no other tracker file.`;
}

/** The scratch rule for a named task: logs and drafts live in the worktree's own .krn/tmp, so no path leaves the worktree. */
export function scratchRule(): string {
  return '- Scratch: write logs, drafts and PR bodies under `.krn/tmp/` inside your own worktree (it disappears with the worktree); never write `../../x.log` or any path outside the worktree.';
}

/** The lane brief with the FR-40 carrier prefix; `closure` appends the closure line (only `krn lane brief --task` sets it, so the measured carrier stays byte-identical) (D0, t-5983e6g): the measured arm-B prompt. */
export function laneBriefText(
  repo: string,
  brief: string,
  asOf: string,
  task = 'lane-brief',
  closure = false,
  budget?: number,
  holdout = true,
): string {
  return laneBrief(repo, brief, asOf, task, closure, budget, holdout).text;
}

export type LaneBrief = {
  text: string;
  packet: string | null;
  /** Tokens of the packet the brief carries. */
  tokens: number;
  /** Ids of the records the packet served. */
  served: string[];
  /** Ids of the records the packet would have served that the task's holdout kept out, so their effect can be measured. */
  withheld: string[];
};

/** The lane brief and the sha256 of the packet it carries (null when it carries none), so a run can record which packet it served. */
export function laneBrief(
  repo: string,
  brief: string,
  asOf: string,
  task = 'lane-brief',
  closure = false,
  budget?: number,
  /** False only for the frozen FR-40 carrier, which withholds nothing. */
  holdout = true,
): LaneBrief {
  // A named task keys the packet by its title, Outcome, Files, stack and area as well as the brief's words.
  const key = taskKey(repo, task);
  const query =
    key === undefined ? brief : `${brief}\n${taskQueryText(key, [])}`;
  const packet = lanePacket(repo, query, asOf, task, budget, holdout);
  const served = packet?.records ?? [];
  // Withheld is what the packet would have served without the holdout, intersected with the holdout.
  const withheld = holdout
    ? (
        lanePacket(repo, query, asOf, task, budget, false)?.records ?? []
      ).filter((id) => heldOut(task, id))
    : [];
  const text = packetBrief(packet, brief, holdout);
  const precedent = precedentSection(repo, brief);
  const recipe =
    findContract(repo)?.contract.vacuous === true ? firstTestSection(repo) : '';
  // The frozen FR-40 carrier (holdout false) stays byte-stable: no clause section.
  const clauses =
    holdout &&
    process.env.KRN_ACCEPTANCE_CLAUSES !== '0' &&
    armOn(findContract(repo)?.contract, 'clauses')
      ? clauseSection(
          statedBody(brief),
          isBugBody(statedBody(brief)) ? callSiteSweep(repo, brief) : [],
        )
      : '';
  // The frozen FR-40 carrier (holdout false) never gets the gates block.
  const gates = holdout ? (gatesBlock(repo, asOf) ?? '') : '';
  const body = [text, gates, precedent, recipe, clauses]
    .filter((part) => part !== '')
    .map((part) => part.trimEnd())
    .join('\n\n');
  return {
    text: `${body.trimEnd()}\n\n${workerRules(repo)}${closure ? `\n${closureRule(task)}\n${scratchRule()}` : ''}\n`,
    packet:
      packet === null || packet.records.length === 0 ? null : packet.sha256,
    tokens: packet?.tokens ?? 0,
    served: [...served],
    withheld,
  };
}

/** The task's own words: the brief without its title line, acceptance-lines block and delivery boilerplate. */
export function statedBody(brief: string): string {
  const cut = brief.search(/\n\n(?:Acceptance lines |Deliver this )/u);
  const text = cut === -1 ? brief : brief.slice(0, cut);
  return text.replace(/^Task t-[a-z0-9]+: [^\n]*\n+/u, '');
}
