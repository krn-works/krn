import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  serializeTask,
  TaskCommandError,
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
  getTask,
  listTasks,
  repositoryRoot,
} from './store.ts';

export function taskCommand(args: string[]): void {
  try {
    const output = execute(args);
    if (output !== '') process.stdout.write(output);
  } catch (error) {
    if (error instanceof TaskDataError)
      throw new TaskCommandError(error.findings.join('\n'), 65);
    if (error instanceof TaskUsageError)
      throw new TaskCommandError(error.message, 64);
    throw error;
  }
}

function execute(args: string[]): string {
  const [command, ...options] = args;
  if (command === 'check') {
    if (options.length > 0) throw usage('task check takes no options');
    const root = repositoryRoot();
    const findings = checkTaskDirectory(root);
    if (findings.length > 0) throw new TaskDataError(findings);
    return 'Task data is valid.\n';
  }

  if (command === 'create') return create(options);
  if (command === 'show') return show(options);
  if (command === 'list') return list(options);
  if (command === 'close') return close(options);
  if (command === 'dep') return dependency(options);
  throw usage('usage: krn task create|show|list|close|dep|check');
}

function create(args: string[]): string {
  let title: string | undefined;
  let priority: number | undefined;
  let bodyFile: string | undefined;
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
    } else throw usage(`unknown create option "${option}"`);
  }
  if (title === undefined) throw usage('task create requires --title');

  const body = bodyFile === undefined ? [] : readBody(bodyFile);
  const record = createTask(repositoryRoot(), {
    title,
    after,
    body,
    ...(priority === undefined ? {} : { priority }),
  });
  return `${record.id}\n`;
}

function show(args: string[]): string {
  let json = false;
  let id: string | undefined;
  for (const option of args) {
    if (option === '--json') {
      if (json) throw usage('--json may be supplied once');
      json = true;
    } else if (id === undefined && !option.startsWith('--')) id = option;
    else throw usage(`unexpected show argument "${option}"`);
  }
  if (id === undefined) throw usage('usage: krn task show ID [--json]');
  const record = getTask(repositoryRoot(), requireId(id));
  return json ? serializeTask(record) : formatTask(record);
}

function list(args: string[]): string {
  let json = false;
  let status: TaskStatus | 'all' = 'open';
  let statusSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--json') {
      if (json) throw usage('--json may be supplied once');
      json = true;
    } else if (option === '--status') {
      if (statusSeen) throw usage('--status may be supplied once');
      const value = nextValue(args, index++, option);
      if (value !== 'open' && value !== 'closed' && value !== 'all')
        throw usage('--status must be open, closed, or all');
      status = value;
      statusSeen = true;
    } else throw usage(`unknown list option "${option}"`);
  }
  const records = listTasks(repositoryRoot(), status);
  return json
    ? `${JSON.stringify(records, null, 2)}\n`
    : records.map(formatTask).join('');
}

function close(args: string[]): string {
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
  const record = closeTask(repositoryRoot(), requireId(id), resolution);
  return `${record.id}\n`;
}

function dependency(args: string[]): string {
  const [operation, id, ...options] = args;
  if (operation !== 'add' && operation !== 'rm')
    throw usage('usage: krn task dep add|rm ID --after ID');
  if (id === undefined) throw usage('usage: krn task dep add|rm ID --after ID');
  if (options.length !== 2 || options[0] !== '--after')
    throw usage('usage: krn task dep add|rm ID --after ID');
  const dependency = options[1];
  if (dependency === undefined)
    throw usage('usage: krn task dep add|rm ID --after ID');
  const record = changeDependency(
    repositoryRoot(),
    requireId(id),
    requireId(dependency),
    operation,
  );
  return `${record.id}\n`;
}

function readBody(path: string): string[] {
  const contents =
    path === '-'
      ? readFileSync(0, 'utf8')
      : readFileSync(resolve(path), 'utf8');
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
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw usage(`missing value for ${option}`);
  return value;
}

function formatTask(record: TaskRecord): string {
  const lines = [
    `${record.id} ${record.title}`,
    `Status: ${record.status}`,
    `Priority: ${record.priority}`,
    `Created: ${record.created}`,
    `After: ${record.after.length === 0 ? '—' : record.after.join(', ')}`,
  ];
  if (record.resolution !== null) {
    lines.push(
      `Resolution: ${record.resolution.kind}${record.resolution.ref === null ? '' : ` (${record.resolution.ref})`}`,
    );
    if (record.resolution.note !== '')
      lines.push(`Note: ${record.resolution.note}`);
  }
  if (record.body.length > 0) lines.push('', ...record.body, '');
  return `${lines.join('\n')}\n`;
}

function usage(message: string): TaskUsageError {
  return new TaskUsageError(message);
}
