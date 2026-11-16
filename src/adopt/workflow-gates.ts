// Which contract gate commands the repository's existing workflows already run: adopt fills only the gaps.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findContract } from '../repo/contract.ts';

export const GATE_KEYS = ['lint', 'typecheck', 'test'] as const;
export type GateKey = (typeof GATE_KEYS)[number];
export type GateCommands = Partial<Record<GateKey, string | undefined>>;

const WORKFLOWS = '.github/workflows';

export interface WorkflowGates {
  /** Per gate key with a command, the workflow files (repository-relative) that run it. */
  runBy: Partial<Record<GateKey, string[]>>;
  /** Gate keys with a command that no read workflow runs. */
  missing: GateKey[];
  /** Gate keys whose command two or more workflows run. */
  duplicated: GateKey[];
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const COMMAND_KEY =
  /^(\s*)(?:-\s+)?(run|install|lint|typecheck|test):\s*(.*)$/u;

/**
 * The shell text a workflow runs: each `run:` step and each `install`, `lint`, `typecheck` or `test`
 * input of a reusable-workflow call, block scalars (`|`, `>`) included. Other keys
 * (`cancel-in-progress: true`, names, comments) are not commands.
 */
export function workflowCommands(text: string): string[] {
  const lines = text.split('\n');
  const commands: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = COMMAND_KEY.exec(lines[index] ?? '');
    if (match === null) continue;
    const indent = (match[1] ?? '').length;
    const value = (match[3] ?? '').trim();
    if (!/^[|>][-+]?$/u.test(value)) {
      if (value !== '') commands.push(value.replace(/^(['"])(.*)\1$/u, '$2'));
      continue;
    }
    const block: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? '';
      if (next.trim() !== '' && next.length - next.trimStart().length <= indent)
        break;
      block.push(next.trim());
      index += 1;
    }
    commands.push(block.join('\n').trim());
  }
  return commands;
}

/** True when `text` runs `command` as a whole command, not as the prefix of a longer one (`npm test` is not `npm test:e2e`). */
export function runsCommand(text: string, command: string): boolean {
  const pattern = new RegExp(
    `(?:^|[\\s;&|(])${escaped(command.trim())}(?=$|[\\s;&|)])`,
    'mu',
  );
  return workflowCommands(text).some((run) => pattern.test(run));
}

const MISE_RUN = /(?:^|[\s;&|(])mise\s+run\s+([\w:.-]+)/gu;

/** The text of each `[tasks.<name>]` table of the repository's mise.toml, by task name. */
function miseTasks(root: string): Map<string, string> {
  const tasks = new Map<string, string>();
  const file = join(root, 'mise.toml');
  if (!existsSync(file)) return tasks;
  const parts = readFileSync(file, 'utf8').split(
    /^\[tasks\.("?)([^\]"]+)\1\]\s*$/mu,
  );
  for (let index = 1; index + 2 < parts.length; index += 3)
    tasks.set(parts[index + 1] ?? '', parts[index + 2] ?? '');
  return tasks;
}

/** True when a `mise run <task>` step of `text` reaches `command` through the task's `run` or `depends`. */
function runsViaMise(
  text: string,
  command: string,
  tasks: Map<string, string>,
): boolean {
  if (tasks.size === 0) return false;
  const seen = new Set<string>();
  const reaches = (name: string): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const body = tasks.get(name);
    if (body === undefined) return false;
    const commands = body
      .replace(/^depends\s*=\s*\[[^\]]*\]/gmu, '')
      .replace(/^(?:depends|description|usage)\s*=.*$/gmu, '')
      .matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/gu);
    if (
      [...commands].some((m) => runsCommand(`- run: ${m[1] ?? m[2]}`, command))
    )
      return true;
    const depends = /^depends\s*=\s*\[([^\]]*)\]/mu.exec(body)?.[1] ?? '';
    return [...depends.matchAll(/"([^"]+)"/gu)].some((match) =>
      reaches(match[1] ?? ''),
    );
  };
  return workflowCommands(text).some((run) =>
    [...run.matchAll(MISE_RUN)].some((match) => reaches(match[1] ?? '')),
  );
}

/** The repository's workflow files as repository-relative path and text, sorted, minus `exclude`. */
export function readWorkflows(
  root: string,
  exclude: readonly string[] = [],
): { file: string; text: string }[] {
  const dir = join(root, WORKFLOWS);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => `${WORKFLOWS}/${name}`)
    .filter((file) => !exclude.includes(file))
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));
}

/** Reads the workflows (minus `exclude`) and reports, per contract gate command, which of them run it. */
export function workflowGates(
  root: string,
  commands: GateCommands,
  exclude: readonly string[] = [],
): WorkflowGates {
  const workflows = readWorkflows(root, exclude);
  const tasks = miseTasks(root);
  const result: WorkflowGates = { runBy: {}, missing: [], duplicated: [] };
  for (const key of GATE_KEYS) {
    const command = commands[key];
    if (command === undefined || command.trim() === '') continue;
    const files = workflows
      .filter(
        (workflow) =>
          runsCommand(workflow.text, command) ||
          runsViaMise(workflow.text, command, tasks),
      )
      .map((workflow) => workflow.file);
    result.runBy[key] = files;
    if (files.length === 0) result.missing.push(key);
    if (files.length > 1) result.duplicated.push(key);
  }
  return result;
}

/** The commands of `commands` minus every gate that `gates` says a workflow already runs. */
export function onlyMissing<T extends GateCommands>(
  commands: T,
  gates: WorkflowGates,
): T {
  const next = { ...commands };
  for (const key of GATE_KEYS)
    if ((gates.runBy[key]?.length ?? 0) > 0) delete next[key];
  return next;
}

/** The `s-gate-in-ci` verdict: a workflow runs on pull requests and runs every contract gate, directly or through a mise task. */
export function ciGateProblem(root: string): string | undefined {
  const workflows = readWorkflows(root);
  if (!workflows.some(({ text }) => /pull_request|merge_request/u.test(text)))
    return 'no workflow runs on pull requests';
  const found = findContract(root);
  const contract = found?.contract;
  const gates = workflowGates(root, {
    lint: contract?.lint,
    typecheck: contract?.typecheck,
    test: contract?.vacuous ? undefined : contract?.test,
  });
  const missing: string[] = [...gates.missing];
  if (contract === undefined) missing.unshift('test');
  return missing.length === 0
    ? undefined
    : `CI does not run the contract commands: ${missing.join(', ')}`;
}
