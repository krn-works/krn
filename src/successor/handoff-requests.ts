// Handoff request check.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resumeProblems, roadmapIds } from '../memory/handoff-resume.ts';
import {
  markHandoff,
  oneLine,
  openEntries,
} from '../memory/operator-inbox-store.ts';

// The inbox-to-task invariant: no operator prompt lacks a disposition, and every open task that records an
// operator request is named in the handoff. The handoff's prose layout is not checked.
// run() returns the exit code; scripts/claude/handoff-requests.ts only wires argv and the streams.
export const usage =
  'Usage: node scripts/claude/handoff-requests.ts <handoff.md> [--root <repository>]';

class Failure extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

function failure(message: string, code: number): never {
  throw new Failure(message, code);
}

// A task body records an operator request when it quotes the operator verbatim or reports
// what the operator asked or said.
const operatorPattern =
  /\bverbatim\b|\bOperator\b[^.\n]{0,80}?(?:\basked\b|\bsaid\b|\brequested\b|\):|:\s*["“])/u;

function operatorTasks(root: string): string[] {
  const directory = join(root, 'tasks');
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names.sort()) {
    if (!/^t-[a-z0-9]{7}\.json$/u.test(name)) continue;
    let task: { id?: unknown; status?: unknown; body?: unknown };
    try {
      task = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    } catch {
      continue;
    }
    if (task.status !== 'open' || !Array.isArray(task.body)) continue;
    if (operatorPattern.test(task.body.join('\n')))
      ids.push(name.slice(0, -'.json'.length));
  }
  return ids;
}

function options(arguments_: string[], cwd: string) {
  let handoff: string | undefined;
  let root = cwd;
  const queue = [...arguments_];
  for (
    let argument = queue.shift();
    argument !== undefined;
    argument = queue.shift()
  ) {
    if (argument === '--root') {
      const value = queue.shift();
      if (!value) failure(usage, 64);
      root = resolve(value);
    } else if (!argument.startsWith('-') && handoff === undefined)
      handoff = resolve(argument);
    else failure(usage, 64);
  }
  if (!handoff) failure(usage, 64);
  return { handoff, root };
}

// The problems a handoff text has, one FAIL line each, and how many open operator tasks it carries.
export function handoffProblems(
  handoff: string,
  text: string,
  root: string,
): { failures: string[]; open: number } {
  const failures: string[] = [];
  for (const problem of resumeProblems(text))
    failures.push(`FAIL ${handoff}: ${problem}`);

  const file = (path: string) =>
    statSync(path, { throwIfNoEntry: false })?.isFile() === true;

  // A named roadmap change is a task id: the roadmap is generated from tasks/,
  // so a closed task still names a change but an unknown id does not.
  for (const id of roadmapIds(text))
    if (!file(join(root, 'tasks', `${id}.json`)))
      failures.push(
        `FAIL ${handoff}: Roadmap names ${id}, which has no task file in tasks/`,
      );
  // Carry-over: an open task that records an operator utterance must be named in the section,
  // so a hand-written handoff cannot silently drop a request the operator already made.
  const operator = operatorTasks(root);
  for (const id of operator)
    if (!text.includes(id))
      failures.push(
        `FAIL ${handoff}: open operator request ${id} is not named in the handoff; carry it or close the task`,
      );

  // Inbox: every directive-like operator prompt since the last handoff needs a disposition.
  for (const entry of openEntries(root))
    failures.push(
      `FAIL ${handoff}: operator prompt ${entry.hash} has no disposition: "${oneLine(entry.text, 100)}"; run node scripts/claude/operator-inbox.ts dispose ${entry.hash} --task <id> | --memory <slug> | --answered <reason>`,
    );

  return { failures, open: operator.length };
}

export function run(
  args: string[],
  cwd: string,
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
): number {
  try {
    const { handoff, root } = options(args, cwd);
    let text: string;
    try {
      text = readFileSync(handoff, 'utf8');
    } catch {
      return failure(`FAIL ${handoff}: unreadable`, 1);
    }
    const { failures, open } = handoffProblems(handoff, text, root);
    if (failures.length > 0) failure(failures.join('\n'), 1);
    markHandoff(root);
    io.stdout(`PASS ${handoff}: ${open} open operator request(s) recorded\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    io.stderr(`${error.message}\n`);
    return error.code;
  }
}
