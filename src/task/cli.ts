import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { commandErrorExitCode } from '../cli/command-error.ts';
import { flagValue } from '../cli/flag-value.ts';
import {
  claimHolder,
  claimNext,
  claimTask,
  formatClaim,
  inspectClaim,
  mainCheckoutRoot,
  readyTasks,
  registeredTaskWorktree,
  releaseClaim,
  taskRecordRoot,
} from './claims.ts';
import {
  appendComment,
  gitActor,
  readComments,
  type TaskComment,
} from './comments.ts';
import {
  TaskDataError,
  type TaskId,
  type TaskRecord,
  type TaskResolution,
  type TaskStatus,
  TaskUsageError,
} from './record.ts';
import {
  changeDependency,
  checkTaskDirectory,
  closeTask,
  createTask,
  editTask,
  getTask,
  listTasks,
  repositoryRoot,
} from './store.ts';
import { assertWorkerIdle } from './worker-busy.ts';

interface CommandOutput {
  text: string;
  value: Record<string, unknown>;
  json: boolean;
}

const quickstart = [
  'krn task — agent quickstart',
  'Lead runs the loop: krn task ready → krn task claim --next --actor lead → work in a worktree → krn task release ID or krn task close ID --as done in the delivering PR.',
  'Workers receive the task id in their brief and do not mutate tracker state.',
  'Records: tasks/<id>.json (tracked); claims: .krn/task-claims/<id>.json (ignored, shared from the main checkout).',
  'Exit codes: 0 success; 64 usage; 65 invalid task data; 70 internal error; 75 held claim or no ready task.',
  '',
  'krn task ready',
  'krn task claim --next --actor lead',
  'krn task show t-a1b2c3d',
  'krn task list --status all',
  'krn task create --title "Add a task" --priority 1 --body-file -',
  'krn task edit t-a1b2c3d --title "Update task"',
  'krn task comment t-a1b2c3d --body-file -',
  'krn task dep add t-a1b2c3d --after t-b2c3d4e',
  'krn task close t-a1b2c3d --as done',
  'krn task release t-a1b2c3d',
  'krn task check',
  'Use `krn task <verb> --help` for options. Add --json for machine-readable output.',
].join('\n');

const verbHelp: Record<string, string> = {
  create:
    'krn task create --title T [--priority 0..3] [--after ID] [--body-file FILE|-] [--worktree PATH] [--json]\nCreate one task. Example: krn task create --title "Add a task" --priority 1 --json',
  show: 'krn task show ID [--json]\nShow task details, blockers, dependents, and claim. Example: krn task show t-a1b2c3d --json',
  list: 'krn task list [--status open|closed|all] [--json]\nList tasks. Example: krn task list --status all --json',
  ready:
    'krn task ready [--limit N] [--explain ID] [--json]\nList ready tasks one line each (see `krn task show ID` for the body), or explain one task. Example: krn task ready --explain t-a1b2c3d --json',
  claim:
    'krn task claim ID --actor NAME [--worktree PATH] [--reason TEXT] [--takeover --reason TEXT] [--json]\nOr use --next instead of ID. Example: krn task claim --next --actor lead --json',
  release:
    'krn task release ID [--json]\nRelease a task claim. Example: krn task release t-a1b2c3d --json',
  close:
    'krn task close ID --as done|dropped|duplicate:ID|superseded:ID [--note TEXT] [--json]\nClose a task. Example: krn task close t-a1b2c3d --as done --json',
  dep: 'krn task dep add|rm ID --after ID [--json]\nChange a blocking dependency. Example: krn task dep add t-a1b2c3d --after t-b2c3d4e --json',
  edit: 'krn task edit ID [--title T] [--priority N] [--body-file FILE|-] [--append-body TEXT] [--reopen] [--json]\nEdit task fields; use --reopen for closed tasks. Example: krn task edit t-a1b2c3d --title "Updated task" --json',
  comment:
    'krn task comment ID --body-file FILE|- [--actor NAME] [--json]\nAppend a signed, dated comment; workers may comment but never change status. Actor defaults to git user.name. Example: krn task comment t-a1b2c3d --body-file - --json',
  check:
    'krn task check [--json]\nValidate task records and references. Example: krn task check --json',
};

export async function taskCommand(args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    if (args.filter((argument) => argument === '--json').length > 1)
      throw usage('--json may be supplied once');
    const commandArgs = args.filter((argument) => argument !== '--json');
    const result = await execute(commandArgs, json);
    process.stdout.write(
      result.json
        ? `${JSON.stringify({ ok: true, ...result.value }, null, 2)}\n`
        : result.text,
    );
  } catch (error) {
    const failure = taskFailure(error);
    process.stderr.write(`${failure.message}\n`);
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: false,
            code: failure.code,
            error: failure.message,
            ...(failure.findings === undefined
              ? {}
              : { findings: failure.findings }),
          },
          null,
          2,
        )}\n`,
      );
    }
    process.exitCode = failure.code;
  }
}

async function execute(args: string[], json: boolean): Promise<CommandOutput> {
  const [command, ...options] = args;
  if (command === undefined || command === 'help' || command === '--help')
    return { text: `${quickstart}\n`, value: {}, json: false };
  if (options.includes('--help')) {
    if (options.length !== 1) throw usage(`usage: krn task ${command} --help`);
    const help = verbHelp[command];
    if (help === undefined) throw usage(`unknown task verb "${command}"`);
    return { text: `${help}\n`, value: {}, json: false };
  }

  if (command === 'check') return check(options, json);
  if (command === 'create') return create(options, json);
  if (command === 'show') return show(options, json);
  if (command === 'list') return list(options, json);
  if (command === 'close') return close(options, json);
  if (command === 'dep') return dependency(options, json);
  if (command === 'ready') return ready(options, json);
  if (command === 'claim') return claim(options, json);
  if (command === 'release') return release(options, json);
  if (command === 'edit') return edit(options, json);
  if (command === 'comment') return comment(options, json);
  throw usage(`unknown task verb "${command}"`);
}

function check(args: string[], json: boolean): CommandOutput {
  if (args.length > 0) throw usage('task check takes no options');
  const findings = checkTaskDirectory(repositoryRoot());
  if (findings.length > 0) throw new TaskDataError(findings);
  return result({ findings: [] }, 'Task data is valid.\n', json);
}

function create(args: string[], json: boolean): CommandOutput {
  let title: string | undefined;
  let priority: number | undefined;
  let bodyFile: string | undefined;
  let worktree: string | undefined;
  const after: TaskId[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--title') {
      if (title !== undefined) throw usage('--title may be supplied once');
      title = nextValue(args, index++, option);
    } else if (option === '--priority') {
      if (priority !== undefined)
        throw usage('--priority may be supplied once');
      const value = nextValue(args, index++, option);
      if (!/^-?\d+$/u.test(value))
        throw new TaskDataError([
          'priority must be an integer between 0 and 3',
        ]);
      priority = Number(value);
    } else if (option === '--after') {
      after.push(requireId(nextValue(args, index++, option)));
    } else if (option === '--body-file') {
      if (bodyFile !== undefined)
        throw usage('--body-file may be supplied once');
      bodyFile = nextValue(args, index++, option);
    } else if (option === '--worktree') {
      if (worktree !== undefined)
        throw usage('--worktree may be supplied once');
      worktree = nextValue(args, index++, option);
    } else throw usage(`unknown create option "${option}"`);
  }
  if (title === undefined) throw usage('task create requires --title');

  const body = bodyFile === undefined ? [] : readBody(bodyFile);
  const cwdRoot = repositoryRoot();
  const targetRoot =
    worktree === undefined
      ? cwdRoot
      : registeredTaskWorktree(cwdRoot, worktree);
  const mainRoot = mainCheckoutRoot(cwdRoot);
  assertWorkerIdle(targetRoot);
  const record = createTask(
    targetRoot,
    {
      title,
      after,
      body,
      ...(priority === undefined ? {} : { priority }),
    },
    { uniquenessRoots: targetRoot === mainRoot ? [] : [mainRoot] },
  );
  return result({ task: record }, `${record.id}\n`, json);
}

function comment(args: string[], json: boolean): CommandOutput {
  let id: string | undefined;
  let bodyFile: string | undefined;
  let actor: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === undefined) continue;
    if (option === '--body-file') {
      if (bodyFile !== undefined)
        throw usage('--body-file may be supplied once');
      bodyFile = nextValue(args, index++, option);
    } else if (option === '--actor') {
      if (actor !== undefined) throw usage('--actor may be supplied once');
      actor = nextValue(args, index++, option);
    } else if (id === undefined && !option.startsWith('--')) id = option;
    else throw usage(`unexpected comment argument "${option}"`);
  }
  if (id === undefined || bodyFile === undefined)
    throw usage('usage: krn task comment ID --body-file FILE|- [--actor NAME]');
  const root = repositoryRoot();
  const taskId = requireId(id);
  getTask(root, taskId);
  const text = readBodyFile(bodyFile);
  const signer = actor ?? gitActor(root);
  if (signer === undefined)
    throw usage('comment requires --actor NAME (git user.name is not set)');
  const entry = appendComment(root, taskId, { actor: signer, text });
  return result(
    { comment: entry },
    `${taskId} ${entry.at} ${entry.actor}\n`,
    json,
  );
}

function show(args: string[], json: boolean): CommandOutput {
  if (args.length !== 1 || args[0] === undefined)
    throw usage('usage: krn task show ID [--json]');
  const root = repositoryRoot();
  const id = requireId(args[0]);
  const record = getTask(root, id);
  const claim = inspectClaim(root, record.id);
  const details = showDetails(root, record);
  const comments = readComments(root, id);
  if (json)
    return result(
      {
        task: record,
        comments,
        ...details,
        claim: {
          state: claim.state,
          reason: claim.reason,
          holder: claim.claim ?? null,
          findings: claim.findings,
        },
      },
      formatShow(record, details, claim, comments),
      true,
    );
  return result(
    { task: record },
    formatShow(record, details, claim, comments),
    false,
  );
}

function ready(args: string[], json: boolean): CommandOutput {
  let limit: number | undefined;
  let explain: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--limit') {
      if (limit !== undefined) throw usage('--limit may be supplied once');
      const value = nextValue(args, index++, option);
      if (
        !/^\d+$/u.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < 1
      )
        throw usage('--limit must be a positive integer');
      limit = Number(value);
    } else if (option === '--explain') {
      if (explain !== undefined) throw usage('--explain may be supplied once');
      explain = nextValue(args, index++, option);
    } else throw usage(`unknown ready option "${option}"`);
  }
  const root = repositoryRoot();
  if (explain !== undefined) {
    if (limit !== undefined)
      throw usage('--limit cannot be combined with --explain');
    const id = requireId(explain);
    const task = getTask(root, id);
    const records = listTasks(root, 'all');
    const claim = inspectClaim(root, id);
    const findings = readinessReasons(task, records, claim);
    for (const finding of claim.findings)
      process.stderr.write(`task-claims/${id}.json: ${finding}\n`);
    return result(
      { task, findings },
      `${task.id}: ${findings.join('; ')}\n`,
      json,
    );
  }

  const readyResult = readyTasks(root, limit);
  for (const finding of readyResult.findings)
    process.stderr.write(
      `task-claims/${finding.id}.json is corrupt: ${finding.findings.join('; ')}\n`,
    );
  return result(
    {
      tasks: readyResult.tasks,
      findings: readyResult.findings,
    },
    readyResult.tasks.map((task) => formatListTask(task)).join(''),
    json,
  );
}

async function claim(args: string[], json: boolean): Promise<CommandOutput> {
  let next = false;
  let takeover = false;
  let id: string | undefined;
  let actor: string | undefined;
  let reason: string | undefined;
  let worktree: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === undefined) continue;
    if (option === '--next') {
      if (next) throw usage('--next may be supplied once');
      next = true;
    } else if (option === '--takeover') {
      if (takeover) throw usage('--takeover may be supplied once');
      takeover = true;
    } else if (option === '--actor') {
      if (actor !== undefined) throw usage('--actor may be supplied once');
      actor = nextValue(args, index++, option);
    } else if (option === '--reason') {
      if (reason !== undefined) throw usage('--reason may be supplied once');
      reason = nextValue(args, index++, option);
    } else if (option === '--worktree') {
      if (worktree !== undefined)
        throw usage('--worktree may be supplied once');
      worktree = nextValue(args, index++, option);
    } else if (id === undefined && !option.startsWith('--')) id = option;
    else throw usage(`unexpected claim argument "${option}"`);
  }
  if (actor === undefined || actor.trim() === '')
    throw usage('claim requires --actor A');
  if (takeover && (reason === undefined || reason.trim() === ''))
    throw usage('--takeover requires --reason R');
  if (next && id !== undefined) throw usage('claim --next does not take an ID');
  if (!next && id === undefined)
    throw usage('usage: krn task claim ID --actor A | --next --actor A');
  if (next && takeover) throw usage('--takeover requires a task ID');

  const root = repositoryRoot();
  const options = {
    actor,
    ...(reason === undefined ? {} : { reason }),
    ...(worktree === undefined ? {} : { worktree }),
    ...(takeover ? { takeover: true } : {}),
  };
  const claimed = next
    ? await claimNext(root, options)
    : await claimTask(root, requireId(id ?? ''), options);
  const inspection = inspectClaim(root, claimed.id);
  const lines: string[] = [];
  if (claimed.removedExpired !== undefined)
    process.stderr.write(
      `Expired claim for ${claimed.id} was removed (${claimHolder(claimed.removedExpired)}).\n`,
    );
  if (claimed.previous !== undefined)
    lines.push(`Previous holder: ${claimHolder(claimed.previous)}`);
  lines.push(claimed.id);
  return result(
    { claim: inspection.claim ?? null },
    `${lines.join('\n')}\n`,
    json,
  );
}

async function release(args: string[], json: boolean): Promise<CommandOutput> {
  if (args.length !== 1 || args[0] === undefined)
    throw usage('usage: krn task release ID [--json]');
  const id = requireId(args[0]);
  await releaseClaim(repositoryRoot(), id);
  return result({ claim: null }, `${id}\n`, json);
}

function list(args: string[], json: boolean): CommandOutput {
  let status: TaskStatus | 'all' = 'open';
  let statusSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--status') {
      if (statusSeen) throw usage('--status may be supplied once');
      const value = nextValue(args, index++, option);
      if (value !== 'open' && value !== 'closed' && value !== 'all')
        throw usage('--status must be open, closed, or all');
      status = value;
      statusSeen = true;
    } else throw usage(`unknown list option "${option}"`);
  }
  const records = listTasks(repositoryRoot(), status);
  return result({ tasks: records }, records.map(formatListTask).join(''), json);
}

function close(args: string[], json: boolean): CommandOutput {
  let id: string | undefined;
  let resolutionArg: string | undefined;
  let note: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === undefined) continue;
    if (option === '--as') {
      if (resolutionArg !== undefined) throw usage('--as may be supplied once');
      resolutionArg = nextValue(args, index++, option);
    } else if (option === '--note') {
      if (note !== undefined) throw usage('--note may be supplied once');
      note = nextValue(args, index++, option);
    } else if (id === undefined && !option.startsWith('--')) id = option;
    else throw usage(`unexpected close argument "${option}"`);
  }
  if (id === undefined || resolutionArg === undefined)
    throw usage(
      'usage: krn task close ID --as done|dropped|duplicate:ID|superseded:ID [--note N]',
    );
  const resolution = parseResolution(resolutionArg, note ?? '');
  const cwdRoot = repositoryRoot();
  const taskId = requireId(id);
  const root = taskRecordRoot(cwdRoot, taskId);
  assertWorkerIdle(root);
  const record = closeTask(root, taskId, resolution);
  return result({ task: record }, `${record.id}\n`, json);
}

function dependency(args: string[], json: boolean): CommandOutput {
  const [operation, id, ...options] = args;
  if (operation !== 'add' && operation !== 'rm')
    throw usage('usage: krn task dep add|rm ID --after ID');
  if (id === undefined) throw usage('usage: krn task dep add|rm ID --after ID');
  if (options.length !== 2 || options[0] !== '--after')
    throw usage('usage: krn task dep add|rm ID --after ID');
  const dependencyId = options[1];
  if (dependencyId === undefined)
    throw usage('usage: krn task dep add|rm ID --after ID');
  const root = taskRecordRoot(repositoryRoot(), requireId(id));
  assertWorkerIdle(root);
  const record = changeDependency(
    root,
    requireId(id),
    requireId(dependencyId),
    operation,
  );
  return result({ task: record }, `${record.id}\n`, json);
}

function edit(args: string[], json: boolean): CommandOutput {
  const [id, ...options] = args;
  if (id === undefined)
    throw usage('usage: krn task edit ID [changes] [--json]');
  let title: string | undefined;
  let priority: number | undefined;
  let bodyFile: string | undefined;
  let appendBody: string[] | undefined;
  let reopen = false;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--title') {
      if (title !== undefined) throw usage('--title may be supplied once');
      title = nextValue(options, index++, option);
    } else if (option === '--priority') {
      if (priority !== undefined)
        throw usage('--priority may be supplied once');
      const value = nextValue(options, index++, option);
      if (!/^-?\d+$/u.test(value))
        throw new TaskDataError([
          'priority must be an integer between 0 and 3',
        ]);
      priority = Number(value);
    } else if (option === '--body-file') {
      if (bodyFile !== undefined)
        throw usage('--body-file may be supplied once');
      bodyFile = nextValue(options, index++, option);
    } else if (option === '--append-body') {
      if (appendBody !== undefined)
        throw usage('--append-body may be supplied once');
      const text = nextValue(options, index++, option);
      if (text.trim() === '')
        throw new TaskDataError(['append body must not be empty']);
      appendBody = splitBody(text);
    } else if (option === '--reopen') {
      if (reopen) throw usage('--reopen may be supplied once');
      reopen = true;
    } else throw usage(`unknown edit option "${option}"`);
  }
  if (
    title === undefined &&
    priority === undefined &&
    bodyFile === undefined &&
    appendBody === undefined &&
    !reopen
  )
    throw usage('task edit requires at least one change');

  const cwdRoot = repositoryRoot();
  const taskId = requireId(id);
  const root = taskRecordRoot(cwdRoot, taskId);
  const current = getTask(root, taskId);
  if (current.status === 'closed' && !reopen)
    throw new TaskDataError([
      `tasks/${taskId}.json: task is closed; use --reopen to edit it`,
    ]);
  const body = bodyFile === undefined ? undefined : readBody(bodyFile);
  assertWorkerIdle(root);
  const record = editTask(root, taskId, {
    ...(title === undefined ? {} : { title }),
    ...(priority === undefined ? {} : { priority }),
    ...(body === undefined ? {} : { body }),
    ...(appendBody === undefined ? {} : { appendBody }),
    ...(reopen ? { reopen: true } : {}),
  });
  return result({ task: record }, `${record.id}\n`, json);
}

function readBody(path: string): string[] {
  return splitBody(readBodyFile(path));
}

function readBodyFile(path: string): string {
  try {
    return path === '-'
      ? readFileSync(0, 'utf8')
      : readFileSync(resolve(path), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw usage(`cannot read --body-file ${path}${code ? ` (${code})` : ''}`);
  }
}

function splitBody(contents: string): string[] {
  const normalized = contents.replace(/\r\n?/gu, '\n').trim();
  if (normalized === '') return [];
  return normalized
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function parseResolution(value: string, note: string): TaskResolution {
  if (value === 'done' || value === 'dropped')
    return { kind: value, ref: null, note };
  const separator = value.indexOf(':');
  if (separator < 0)
    throw usage('--as must be done, dropped, duplicate:ID, or superseded:ID');
  const kind = value.slice(0, separator);
  const ref = value.slice(separator + 1);
  if (kind !== 'duplicate' && kind !== 'superseded')
    throw usage('--as must be done, dropped, duplicate:ID, or superseded:ID');
  return { kind, ref: requireId(ref), note };
}

function requireId(value: string): TaskId {
  if (!/^[A-Za-z]+-[0-9A-Za-z]+$/u.test(value))
    throw usage(`invalid task id "${value}"`);
  return value;
}

function nextValue(args: string[], index: number, option: string): string {
  return flagValue(args, index, () => usage(`missing value for ${option}`));
}

function formatShow(
  task: TaskRecord,
  details: ShowDetails,
  claim: ReturnType<typeof inspectClaim>,
  comments: TaskComment[],
): string {
  const blocking = details.blockers
    .filter((dependency) => dependency.blocking)
    .map(formatBlocker);
  return `${formatTask(task, [
    `Blockers: ${blocking.length === 0 ? 'none' : blocking.join(', ')}`,
    `Dependents: ${details.dependents.length === 0 ? 'none' : details.dependents.join(', ')}`,
  ])}${formatClaim(claim).join('\n')}\n${formatComments(comments)}`;
}

function formatComments(comments: TaskComment[]): string {
  if (comments.length === 0) return '';
  return `\nComments (${comments.length}):\n${comments
    .map(
      (entry) =>
        `- ${entry.at} ${entry.actor}: ${entry.text.replace(/\n/gu, '\n  ')}\n`,
    )
    .join('')}`;
}

interface TaskBlocker {
  id: TaskId;
  status: TaskStatus | 'missing';
  resolution: TaskResolution['kind'] | null;
  blocking: boolean;
}

interface ShowDetails {
  blockers: TaskBlocker[];
  dependents: TaskId[];
}

function showDetails(root: string, task: TaskRecord): ShowDetails {
  const records = listTasks(root, 'all');
  const byId = new Map(records.map((record) => [record.id, record]));
  const blockers = task.after.map((id): TaskBlocker => {
    const dependency = byId.get(id);
    const blocking =
      dependency?.status !== 'closed' || dependency.resolution?.kind !== 'done';
    return {
      id,
      status: dependency?.status ?? 'missing',
      resolution: dependency?.resolution?.kind ?? null,
      blocking,
    };
  });
  const dependents = records
    .filter((record) => record.after.includes(task.id))
    .map((record) => record.id)
    .sort();
  return { blockers, dependents };
}

function formatBlocker(dependency: TaskBlocker): string {
  if (dependency.status === 'missing') return `${dependency.id} (missing)`;
  if (dependency.status === 'open') return `${dependency.id} (open)`;
  return `${dependency.id} (closed as ${dependency.resolution ?? 'unknown'})`;
}

function formatTask(task: TaskRecord, extraLines: string[] = []): string {
  const lines = [
    `${task.id} ${task.title}`,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    `Created: ${task.created}`,
    `After: ${task.after.length === 0 ? '—' : task.after.join(', ')}`,
    ...extraLines,
  ];
  if (task.resolution !== null) {
    lines.push(
      `Resolution: ${task.resolution.kind}${task.resolution.ref === null ? '' : ` (${task.resolution.ref})`}`,
    );
    if (task.resolution.note !== '')
      lines.push(`Note: ${task.resolution.note}`);
  }
  if (task.body.length > 0) lines.push('', ...task.body, '');
  return `${lines.join('\n')}\n`;
}

function dependencyBlockers(
  task: TaskRecord,
  records: Map<TaskId, TaskRecord>,
): string[] {
  return task.after.flatMap((id) => {
    const dependency = records.get(id);
    if (
      dependency?.status === 'closed' &&
      dependency.resolution?.kind === 'done'
    )
      return [];
    if (dependency === undefined) return [`${id} (missing)`];
    const state =
      dependency.status === 'open'
        ? 'open'
        : `closed as ${dependency.resolution?.kind ?? 'unknown'}`;
    return [`${id} (${state})`];
  });
}

function readinessReasons(
  task: TaskRecord,
  records: TaskRecord[],
  claim: ReturnType<typeof inspectClaim>,
): string[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const blockers = dependencyBlockers(task, byId);
  const reasons: string[] = [];
  if (task.status === 'closed') reasons.push('task is closed');
  for (const blocker of blockers)
    reasons.push(`blocked by after task ${blocker}`);
  if (claim.state === 'live')
    reasons.push(`live claim held by ${claimHolder(claim)}`);
  if (claim.state === 'corrupt')
    reasons.push(
      `claim is corrupt${claim.findings.length === 0 ? '' : `: ${claim.findings.join('; ')}`}`,
    );
  return reasons.length > 0 ? reasons : ['task is ready'];
}

function formatListTask(task: TaskRecord): string {
  const dependencies = task.after.length === 0 ? '—' : task.after.join(', ');
  return `${task.id}  P${task.priority}  ${task.status}  ${task.title}  [after: ${dependencies}]\n`;
}

function result(
  value: Record<string, unknown>,
  text: string,
  json: boolean,
): CommandOutput {
  return { text, value, json };
}

function taskFailure(error: unknown): {
  code: number;
  message: string;
  findings?: string[];
} {
  if (error instanceof TaskDataError)
    return {
      code: commandErrorExitCode(error),
      message: error.message,
      findings: error.findings,
    };
  return {
    code: commandErrorExitCode(error),
    message: error instanceof Error ? error.message : String(error),
  };
}

function usage(message: string): TaskUsageError {
  return new TaskUsageError(message);
}
