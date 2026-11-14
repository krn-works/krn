import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { precedentSection } from '../brain/precedent.ts';
import { briefStandards } from '../brain/standards.ts';
import { PROJECT_STANDARDS, readProject } from '../brain/standards-cli.ts';
import { lanePacket, packetBrief } from '../brain/worker-packet.ts';
import { findContract } from '../repo/contract.ts';

/**
 * What a worker is told about the tracker. D23 arm K refused five units because the record or the
 * history said the work was done, while the unit's tests were red: the repository, not the record, is the truth.
 */
const SHARED_RULES = `Worker rules:
- Done means every behavior the task describes has a test in this clone that passes, and your change is committed. A closed task record, an earlier commit or a green existing suite never means done: an earlier commit may cover only part of the task.
- For each behavior, outcome or interface the task states, write a test that checks it at its receiver. If it fails, fix the code; if it passes already, keep the test: the commit then carries the proof. Stop without a commit only when you can name an existing test for every described behavior.
- When the task names an input or output format (for example "unified diffs", "newline-separated lists", "JSON"), write at least one test whose input is the plainest hand-written example of that format exactly as the task words it, never only input your own code or tool produced: your reader must accept every form the wording allows, including the shortest and plainest one.
- A red test outranks tracker state and scope: if a named red test fails without a change to a file outside Scope, edit that file and name it in your final reply. Otherwise stay inside Scope: never edit .agents/, .claude/, AGENTS.md, CLAUDE.md, tasks/ or the roadmap for style, docs or tidiness, and revert such an edit before you commit.
- Your final reply states every claim about an external system (a remote repository, a service, a receiver, a CI run) together with the exact command you ran and its exit code; a claim without them is treated as unverified. Name the credential or token scope the command used, and run the real receiver, not a stand-in.
- When you write the PR body with \`krn pr body\`, pass \`--lane\`: it adds the line the ledger counts as lane authorship.`;

const STOP_SCRIPT = 'src/hook/stop.ts';

/**
 * The worker rules for this repository: the closing check names the Stop script where the
 * repository ships it, else the repo contract's own commands, so a pytest repository on master
 * is never told to run npm.
 */
export function workerRules(
  repo: string,
  testFirst = process.env.KRN_TEST_FIRST === '1',
): string {
  const rules = baseWorkerRules(repo);
  return testFirst ? `${rules}\n- ${TEST_FIRST_RULE}` : rules;
}

/** Arm KT only (KRN_TEST_FIRST=1): the Stop hook enforces it. */
export const TEST_FIRST_RULE =
  'Test first: before you change source, commit or at least write a test that fails against the base source and shows the defect or missing behavior; your session is refused its end unless a changed test fails at the base and passes on your commit.';

function baseWorkerRules(repo: string): string {
  if (existsSync(join(repo, STOP_SCRIPT)))
    return `${SHARED_RULES}\n- Before you end, run 'bin/krn hook stop --check' (it runs the tests the repo contract selects for the files you changed, its guard tests, or the full test command when none relate; '--related' lists them). The session is refused its end while there is no commit or that check is red; the one escape is a final line 'BLOCKER: <what stops you>'.`;
  const contract = findContract(repo)?.contract;
  if (contract === undefined)
    return `${SHARED_RULES}\n- Before you end, run the repository's tests and fix what they report; when you cannot make them pass, end with a final line 'BLOCKER: <what stops you>'.`;
  const fast =
    contract.fast === undefined || contract.fast === contract.test
      ? ''
      : `'${contract.fast}' while you work, then `;
  return `${SHARED_RULES}\n- Before you end, run ${fast}the full test command '${contract.test}' and fix what it reports; changes target branch '${contract.base}'. When you cannot make the tests pass, end with a final line 'BLOCKER: <what stops you>'.`;
}

/** The lane brief with the FR-40 carrier prefix (D0, t-5983e6g): the measured arm-B prompt. */
export function laneBriefText(
  repo: string,
  brief: string,
  asOf: string,
  task = 'lane-brief',
): string {
  return laneBrief(repo, brief, asOf, task).text;
}

/** The lane brief and the sha256 of the packet it carries (null when it carries none), so a run can record which packet it served. */
export function laneBrief(
  repo: string,
  brief: string,
  asOf: string,
  task = 'lane-brief',
): { text: string; packet: string | null } {
  const packet = lanePacket(repo, brief, asOf, task);
  const text = packetBrief(packet, brief);
  const precedent = precedentSection(repo, brief);
  const standards = briefStandards(readProject(repo), asOf, PROJECT_STANDARDS);
  const body = [text, precedent, standards]
    .filter((part) => part !== '')
    .map((part) => part.trimEnd())
    .join('\n\n');
  return {
    text: `${body.trimEnd()}\n\n${workerRules(repo)}\n`,
    packet:
      packet === null || packet.records.length === 0 ? null : packet.sha256,
  };
}
