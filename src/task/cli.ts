import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { commandErrorExitCode } from '../cli-kit/command-error.ts';
import { flagValue } from '../cli-kit/flag-value.ts';
import { ARCHIVE_AFTER_DAYS, archiveClosedTasks } from './archive.ts';
import {
  branchMisses,
  formatBranchMiss,
  gitBranchExists,
} from './branch-evidence.ts';
import { branchTicketFindings } from './branch-tickets.ts';
import { type ClaimPacketSource, storeClauses } from './claim-packet.ts';
import {
  claimHolder,
  claimNext,
  claimTask,
  closeRecordRoot,
  formatClaim,
  inspectClaim,
  mainCheckoutRoot,
  readyTasks,
  registeredTaskWorktree,
  releaseClaim,
  taskRecordRoot,
} from './claims.ts';
import { type CloseEvidenceSink, closeEvidenceOf } from './close-evidence.ts';
import { evidenceMisses, formatEvidenceMiss } from './evidence.ts';
import { addPendingTask, pendingApplies } from './pending.ts';
import { allTaskQualityFailures, recordQualityFailures } from './quality.ts';
import {
  isTaskCategory,
  isTaskId,
  isTaskOriginKind,
  TASK_CATEGORIES,
  TASK_ID_MAX_LENGTH,
  TASK_ORIGINS,
  type TaskCategory,
  TaskDataError,
  type TaskId,
  type TaskOrigin,
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
  dependentsOf,
  editTask,
  getTask,
  listTasks,
  loadTaskIndex,
  readTask,
  repositoryRoot,
} from './store.ts';

interface CommandOutput {
  text: string;
  value: Record<string, unknown>;
  json: boolean;
}

const quickstart = [
  'krn task — agent quickstart',
  'Lead runs the loop: krn task ready → krn task claim --next --actor lead → work in a worktree → krn task release ID or krn task close ID --as done in the delivering PR.',
  'Workers receive the task id in their brief and do not mutate tracker state.',
  `Records: tasks/<id>.json (tracked; ids at most ${TASK_ID_MAX_LENGTH} characters); claims: .krn/task-claims/<id>.json (ignored, shared from the main checkout).`,
  'Exit codes: 0 success; 64 usage; 65 invalid task data; 70 internal error; 75 held claim or no ready task.',
  '',
  'krn task ready',
  'krn task claim --next --actor lead',
  'krn task show t-a1b2c3d',
  'krn task list --status all',
  'krn task create --title "Add a task" --kind feature --area task --priority 1 --body-file -',
  'krn task publish   (ships the records create left pending in the main checkout, one PR)',
  'krn task edit t-a1b2c3d --title "Update task"',
  'krn task dep add t-a1b2c3d --after t-b2c3d4e',
  'krn task close t-a1b2c3d --as done',
  'krn task release t-a1b2c3d',
  'krn task check',
  'krn task check --evidence',
  'Use `krn task <verb> --help` for options. Add --json for machine-readable output.',
].join('\n');

const verbHelp: Record<string, string> = {
  create:
    'krn task create --title T --kind feature|defect|debt|gate|chore|research --area A [--stack S]... [--from KIND:REF] [--priority 0..3] [--after ID] [--body-file FILE|-] [--verify CMD]... [--worktree PATH] [--json]\nCreate one task; each --verify is an acceptance command that `close --as done` runs (exit 66 on failure). Example: krn task create --title "Add a task" --kind feature --area task --priority 1 --json',
  show: 'krn task show ID [--json]\nShow task details, blockers, dependents, and claim. Example: krn task show t-a1b2c3d --json',
  list: 'krn task list [--status open|closed|all] [--kind K] [--area A] [--json]\nList tasks. Example: krn task list --status all --json',
  ready:
    'krn task ready [--limit N] [--explain ID] [--json]\nList ready tasks one line each (see `krn task show ID` for the body), or explain one task. Example: krn task ready --explain t-a1b2c3d --json',
  claim:
    'krn task claim ID --actor NAME [--worktree PATH] [--reason TEXT] [--takeover --reason TEXT] [--json]\nOr use --next instead of ID. Example: krn task claim --next --actor lead --json',
  archive:
    'krn task archive [--older-than DAYS] [--json]\nMove closed tasks created at least DAYS (default 14) ago from tasks/<id>.json into tasks/archive/<YYYY-MM>.jsonl; show, list, check and Ticket: checks read both.',
  release:
    'krn task release ID [--json]\nRelease a task claim. Example: krn task release t-a1b2c3d --json',
  close:
    'krn task close ID --as done|dropped|duplicate:ID|superseded:ID [--note TEXT] [--hidden pass|fail] [--json]\nClose a task; `done` also appends the closing PR, its Check conclusion and the --hidden result to the exposure rows of the clauses stored at claim. Example: krn task close t-a1b2c3d --as done --json',
  dep: 'krn task dep add|rm ID --after ID [--json]\nChange a blocking dependency. Example: krn task dep add t-a1b2c3d --after t-b2c3d4e --json',
  edit: 'krn task edit ID [--title T] [--priority N] [--body-file FILE|-] [--append-body TEXT] [--verify CMD]... [--reopen] [--json]\nEdit task fields; use --reopen for closed tasks. Example: krn task edit t-a1b2c3d --title "Updated task" --json',
  check:
    'krn task check [--base REV [--head REV]] [--quality] [--evidence [--recovery DIR]] [--json]\nValidate task records and references; with --quality, also refuse an open task without a measurable Outcome, a named Proof or a named file, a body dependency missing from after, or a done close without evidence; with --base, also refuse a Ticket: trailer in base..head (head defaults to HEAD) whose task is open or missing; with --evidence, also refuse an open task citing a .krn/runs/ path missing from the main checkout, naming its copy under --recovery DIR when one exists, or naming a feat/, fix/ or chore/ branch that exists neither locally nor on origin. Example: krn task check --evidence --json',
};

export async function taskCommand(
  args: string[],
  packetSource?: ClaimPacketSource,
  evidenceSink?: CloseEvidenceSink,
): Promise<void> {
  const json = args.includes('--json');
  try {
    if (args.filter((argument) => argument === '--json').length > 1)
      throw usage('--json may be supplied once');
    const commandArgs = args.filter((argument) => argument !== '--json');
    const result = await execute(commandArgs, json, packetSource, evidenceSink);
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

async function execute(
  args: string[],
  json: boolean,
  packetSource?: ClaimPacketSource,
  evidenceSink?: CloseEvidenceSink,
): Promise<CommandOutput> {
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
  if (command === 'close') return close(options, json, evidenceSink);
  if (command === 'dep') return dependency(options, json);
  if (command === 'ready') return ready(options, json);
  if (command === 'claim') return claim(options, json, packetSource);
  if (command === 'release') return release(options, json);
  if (command === 'edit') return edit(options, json);
  if (command === 'archive') return archive(options, json);
  throw usage(`unknown task verb "${command}"`);
}

function check(args: string[], json: boolean): CommandOutput {
  let base: string | undefined;
  let head: string | undefined;
  let evidence = false;
  let quality = false;
  let recovery: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--quality') {
      if (quality) throw usage('--quality may be supplied once');
      quality = true;
    } else if (option === '--evidence') {
      if (evidence) throw usage('--evidence may be supplied once');
      evidence = true;
    } else if (option === '--recovery') {
      if (recovery !== undefined)
        throw usage('--recovery may be supplied once');
      recovery = nextValue(args, index++, option);
    } else if (option === '--base') {
      if (base !== undefined) throw usage('--base may be supplied once');
      base = nextValue(args, index++, option);
    } else if (option === '--head') {
      if (head !== undefined) throw usage('--head may be supplied once');
      head = nextValue(args, index++, option);
    } else throw usage(`unknown check option "${option}"`);
  }
  if (head !== undefined && base === undefined)
    throw usage('--head requires --base');
  if (recovery !== undefined && !evidence)
    throw usage('--recovery requires --evidence');
  const root = repositoryRoot();
  const findings = checkTaskDirectory(root);
  if (findings.length === 0 && quality)
    findings.push(...allTaskQualityFailures(root));
  if (findings.length === 0 && base !== undefined)
    findings.push(
      ...branchTicketFindings(root, loadTaskIndex(root), base, head ?? 'HEAD'),
    );
  if (findings.length === 0 && evidence)
    findings.push(
      ...evidenceMisses(
        loadTaskIndex(root).values(),
        mainCheckoutRoot(root),
        recovery,
      ).map(formatEvidenceMiss),
      ...branchMisses(loadTaskIndex(root).values(), (branch) =>
        gitBranchExists(root, branch),
      ).map(formatBranchMiss),
    );
  if (findings.length > 0) throw new TaskDataError(findings);
  return result({ findings: [] }, 'Task data is valid.\n', json);
}

function create(args: string[], json: boolean): CommandOutput {
  let title: string | undefined;
  let priority: number | undefined;
  let bodyFile: string | undefined;
  let worktree: string | undefined;
  let kind: TaskCategory | undefined;
  let area: string | undefined;
  let from: TaskOrigin | undefined;
  const stack: string[] = [];
  const after: TaskId[] = [];
  const verify: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--verify') {
      verify.push(parseVerify(nextValue(args, index++, option)));
    } else if (option === '--title') {
      if (title !== undefined) throw usage('--title may be supplied once');
      title = parseTitle(nextValue(args, index++, option));
    } else if (option === '--priority') {
      if (priority !== undefined)
        throw usage('--priority may be supplied once');
      priority = parsePriority(nextValue(args, index++, option));
    } else if (option === '--after') {
      after.push(requireId(nextValue(args, index++, option)));
    } else if (option === '--kind') {
      if (kind !== undefined) throw usage('--kind may be supplied once');
      kind = parseKind(nextValue(args, index++, option));
    } else if (option === '--area') {
      if (area !== undefined) throw usage('--area may be supplied once');
      area = nextValue(args, index++, option);
    } else if (option === '--stack') {
      stack.push(nextValue(args, index++, option));
    } else if (option === '--from') {
      if (from !== undefined) throw usage('--from may be supplied once');
      from = parseFrom(nextValue(args, index++, option));
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
  if (kind === undefined)
    throw usage(`task create requires --kind ${TASK_CATEGORIES.join('|')}`);
  if (area === undefined) throw usage('task create requires --area');

  const body = bodyFile === undefined ? [] : readBody(bodyFile);
  const cwdRoot = repositoryRoot();
  const targetRoot =
    worktree === undefined
      ? cwdRoot
      : registeredTaskWorktree(cwdRoot, worktree);
  const mainRoot = mainCheckoutRoot(cwdRoot);
  // In the main checkout the record waits on the pending ref for `krn task publish`.
  const pending = worktree === undefined && pendingApplies(cwdRoot);
  const record = createTask(
    targetRoot,
    {
      title,
      after,
      body,
      verify,
      kind,
      area,
      stack,
      ...(from === undefined ? {} : { from }),
      ...(priority === undefined ? {} : { priority }),
    },
    {
      uniquenessRoots: targetRoot === mainRoot ? [] : [mainRoot],
      refuse: refuseLowQuality,
      ...(pending
        ? {
            write: (id: string, contents: string) =>
              addPendingTask(cwdRoot, id, contents),
          }
        : {}),
    },
  );
  if (pending)
    process.stderr.write(
      `${record.id} is pending; krn task publish ships every pending record in one PR\n`,
    );
  return result({ task: record, pending }, `${record.id}\n`, json);
}

// The same rules `krn task check --quality` runs in CI, applied before a record is written.
function refuseLowQuality(
  record: Parameters<typeof recordQualityFailures>[0],
  index: ReadonlyMap<string, unknown>,
): string[] {
  return recordQualityFailures(record, index.keys());
}

function parseKind(value: string): TaskCategory {
  if (!isTaskCategory(value))
    throw usage(`--kind must be one of ${TASK_CATEGORIES.join(', ')}`);
  return value;
}

function parseFrom(value: string): TaskOrigin {
  const separator = value.indexOf(':');
  const kind = separator < 0 ? value : value.slice(0, separator);
  const ref = separator < 0 ? '' : value.slice(separator + 1);
  if (!isTaskOriginKind(kind) || ref.trim() === '')
    throw usage(
      `--from must be KIND:REF with KIND one of ${TASK_ORIGINS.join(', ')}`,
    );
  return { kind, ref };
}

function archive(args: string[], json: boolean): CommandOutput {
  let days = ARCHIVE_AFTER_DAYS;
  if (args.length === 2 && args[0] === '--older-than') {
    days = Number(args[1]);
    if (!Number.isInteger(days) || days < 0)
      throw usage('--older-than takes a whole number of days');
  } else if (args.length > 0)
    throw usage('usage: krn task archive [--older-than DAYS] [--json]');
  const root = repositoryRoot();
  const index = loadTaskIndex(root);
  const moved = archiveClosedTasks(root, index.values(), new Date(), days);
  return result(
    { archived: moved.archived, files: moved.files },
    `Archived ${moved.archived.length} task(s) into ${moved.files.length} file(s).\n`,
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
  if (json)
    return result(
      {
        task: record,
        ...details,
        claim: {
          state: claim.state,
          reason: claim.reason,
          holder: claim.claim ?? null,
          findings: claim.findings,
        },
      },
      formatShow(record, details, claim),
      true,
    );
  return result({ task: record }, formatShow(record, details, claim), false);
}

async function ready(args: string[], json: boolean): Promise<CommandOutput> {
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

  const readyResult = await readyTasks(root, limit);
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

async function claim(
  args: string[],
  json: boolean,
  packetSource?: ClaimPacketSource,
): Promise<CommandOutput> {
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
  const packet = packetSource?.(root, claimed.id);
  if (packet !== undefined) {
    storeClauses(root, claimed.id, packet);
    lines.push(packet.text);
  }
  return result(
    {
      claim: inspection.claim ?? null,
      packet:
        packet === undefined
          ? null
          : { clauses: packet.clauses, precedent: packet.precedent },
    },
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
  const filter: { kind?: TaskCategory; area?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--kind')
      filter.kind = parseKind(nextValue(args, index++, option));
    else if (option === '--area')
      filter.area = nextValue(args, index++, option);
    else if (option === '--status') {
      if (statusSeen) throw usage('--status may be supplied once');
      const value = nextValue(args, index++, option);
      if (value !== 'open' && value !== 'closed' && value !== 'all')
        throw usage('--status must be open, closed, or all');
      status = value;
      statusSeen = true;
    } else throw usage(`unknown list option "${option}"`);
  }
  const records = listTasks(repositoryRoot(), status, filter);
  return result({ tasks: records }, records.map(formatListTask).join(''), json);
}

function close(
  args: string[],
  json: boolean,
  evidenceSink?: CloseEvidenceSink,
): CommandOutput {
  let id: string | undefined;
  let hidden: string | undefined;
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
    } else if (option === '--hidden') {
      if (hidden !== undefined) throw usage('--hidden may be supplied once');
      hidden = nextValue(args, index++, option);
    } else if (id === undefined && !option.startsWith('--')) id = option;
    else throw usage(`unexpected close argument "${option}"`);
  }
  if (id === undefined || resolutionArg === undefined)
    throw usage(
      'usage: krn task close ID --as done|dropped|duplicate:ID|superseded:ID [--note N] [--hidden pass|fail]',
    );
  const resolution = parseResolution(resolutionArg, note ?? '');
  const cwdRoot = repositoryRoot();
  const taskId = requireId(id);
  const root =
    resolution.kind === 'done'
      ? closeRecordRoot(cwdRoot, taskId)
      : taskRecordRoot(cwdRoot, taskId);
  if (hidden !== undefined && hidden !== 'pass' && hidden !== 'fail')
    throw usage('--hidden must be pass or fail');
  const hiddenResult = hidden ?? null;
  const record = closeTask(root, taskId, resolution);
  if (resolution.kind === 'done' && evidenceSink !== undefined)
    closeEvidenceOf(root, taskId, hiddenResult, evidenceSink);
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
  const verify: string[] = [];
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--verify') {
      verify.push(parseVerify(nextValue(options, index++, option)));
    } else if (option === '--title') {
      if (title !== undefined) throw usage('--title may be supplied once');
      title = parseTitle(nextValue(options, index++, option));
    } else if (option === '--priority') {
      if (priority !== undefined)
        throw usage('--priority may be supplied once');
      priority = parsePriority(nextValue(options, index++, option));
    } else if (option === '--body-file') {
      if (bodyFile !== undefined)
        throw usage('--body-file may be supplied once');
      bodyFile = nextValue(options, index++, option);
    } else if (option === '--append-body') {
      if (appendBody !== undefined)
        throw usage('--append-body may be supplied once');
      const text = nextValue(options, index++, option);
      if (text.trim() === '') throw usage('--append-body must not be empty');
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
    verify.length === 0 &&
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
  const record = editTask(
    root,
    taskId,
    {
      ...(title === undefined ? {} : { title }),
      ...(priority === undefined ? {} : { priority }),
      ...(body === undefined ? {} : { body }),
      ...(appendBody === undefined ? {} : { appendBody }),
      ...(verify.length === 0 ? {} : { verify }),
      ...(reopen ? { reopen: true } : {}),
    },
    { refuse: refuseLowQuality },
  );
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
  if (!isTaskId(value))
    throw usage(
      `invalid task id "${value}" (letters, "-", alphanumerics; at most ${TASK_ID_MAX_LENGTH} characters)`,
    );
  return value;
}

// Option values are CLI input: a bad one is a usage error (64); 65 stays for
// corrupt stored task data.
function parsePriority(value: string): number {
  if (!/^[0-3]$/u.test(value))
    throw usage('--priority must be an integer between 0 and 3');
  return Number(value);
}

function parseVerify(value: string): string {
  if (value.trim() === '') throw usage('--verify must not be empty');
  return value;
}

function parseTitle(value: string): string {
  if (value.trim() === '') throw usage('--title must not be empty');
  if (/[\r\n]/u.test(value)) throw usage('--title must be a single line');
  return value;
}

function nextValue(args: string[], index: number, option: string): string {
  return flagValue(args, index, () => usage(`missing value for ${option}`));
}

function formatShow(
  task: TaskRecord,
  details: ShowDetails,
  claim: ReturnType<typeof inspectClaim>,
): string {
  const blocking = details.blockers
    .filter((dependency) => dependency.blocking)
    .map(formatBlocker);
  return `${formatTask(task, [
    `Blockers: ${blocking.length === 0 ? 'none' : blocking.join(', ')}`,
    `Dependents: ${details.dependents.length === 0 ? 'none' : details.dependents.join(', ')}`,
  ])}${formatClaim(claim).join('\n')}\n`;
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
  const blockers = task.after.map((id): TaskBlocker => {
    const dependency = readTask(root, id);
    const blocking =
      dependency?.status !== 'closed' || dependency.resolution?.kind !== 'done';
    return {
      id,
      status: dependency?.status ?? 'missing',
      resolution: dependency?.resolution?.kind ?? null,
      blocking,
    };
  });
  return { blockers, dependents: dependentsOf(root, task.id) };
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
