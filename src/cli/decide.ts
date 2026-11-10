// Operator decisions: rows with a recommendation, a default and a deadline.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

export const decideUsage =
  'krn decide add --question T --recommendation T --default T --deadline YYYY-MM-DD [--root DIR]  open a decision row\n' +
  'krn decide list [--all] [--notify] [--root DIR]  open rows with their deadline; --notify prints only rows not yet announced and marks them\n' +
  'krn decide close <id> --by WHO --decision T [--root DIR]  record who decided what';

export interface Decision {
  id: string;
  question: string;
  recommendation: string;
  default: string;
  deadline: string;
  opened: string;
  status: 'open' | 'closed';
  announced?: string;
  decidedBy?: string;
  decision?: string;
  closed?: string;
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;

function directory(root: string): string {
  return join(root, '.krn', 'operator');
}

function readAll(root: string): Decision[] {
  const dir = directory(root);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
    .sort((a: Decision, b: Decision) =>
      a.deadline === b.deadline
        ? a.id.localeCompare(b.id)
        : a.deadline.localeCompare(b.deadline),
    );
}

function write(root: string, row: Decision): void {
  mkdirSync(directory(root), { recursive: true });
  writeFileSync(
    join(directory(root), `${row.id}.json`),
    `${JSON.stringify(row, null, 2)}\n`,
  );
}

export function addDecision(
  root: string,
  fields: Pick<
    Decision,
    'question' | 'recommendation' | 'default' | 'deadline'
  >,
  today: string,
): Decision {
  if (!dayPattern.test(fields.deadline))
    throw new CliUsageError('--deadline must be YYYY-MM-DD');
  const row: Decision = {
    id: `d-${randomBytes(3).toString('hex')}`,
    ...fields,
    opened: today,
    status: 'open',
  };
  write(root, row);
  return row;
}

export function listDecisions(
  root: string,
  options: { all?: boolean; notify?: boolean; today: string },
): string {
  let rows = readAll(root).filter(
    (row) => options.all || row.status === 'open',
  );
  if (options.notify) rows = rows.filter((row) => row.announced === undefined);
  if (options.notify)
    for (const row of rows) write(root, { ...row, announced: options.today });
  return rows
    .map((row) => {
      const state =
        row.status === 'closed'
          ? `closed by ${row.decidedBy}: ${row.decision}`
          : row.deadline < options.today
            ? 'overdue, default applies'
            : 'open';
      return `${row.id}  deadline ${row.deadline}  ${state}\n  ${row.question}\n  recommendation: ${row.recommendation}\n  default: ${row.default}\n`;
    })
    .join('');
}

export function closeDecision(
  root: string,
  id: string,
  by: string,
  decision: string,
  today: string,
): Decision {
  const row = readAll(root).find((candidate) => candidate.id === id);
  if (row === undefined) throw new CliUsageError(`No decision ${id}`);
  if (row.status === 'closed')
    throw new CliUsageError(`Decision ${id} is already closed`);
  const closed: Decision = {
    ...row,
    status: 'closed',
    decidedBy: by,
    decision,
    closed: today,
  };
  write(root, closed);
  return closed;
}

export async function decideCommand(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb !== 'add' && verb !== 'list' && verb !== 'close')
    throw new CliUsageError(decideUsage);
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const positional: string[] = [];
  const valueFlags = [
    '--root',
    '--question',
    '--recommendation',
    '--default',
    '--deadline',
    '--by',
    '--decision',
  ];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (valueFlags.includes(arg)) {
      values.set(
        arg,
        flagValue(rest, i, () => new CliUsageError(`${arg} requires a value`)),
      );
      i += 1;
    } else if (arg === '--all' || arg === '--notify') booleans.add(arg);
    else if (arg.startsWith('--'))
      throw new CliUsageError(`Unknown decide flag: ${arg}`);
    else positional.push(arg);
  }
  const root = values.get('--root') ?? process.cwd();
  const today = new Date().toISOString().slice(0, 10);
  const need = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined || value === '')
      throw new CliUsageError(`${flag} is required\n${decideUsage}`);
    return value;
  };
  if (verb === 'add') {
    const row = addDecision(
      root,
      {
        question: need('--question'),
        recommendation: need('--recommendation'),
        default: need('--default'),
        deadline: need('--deadline'),
      },
      today,
    );
    process.stdout.write(`${row.id}\n`);
  } else if (verb === 'list') {
    process.stdout.write(
      listDecisions(root, {
        all: booleans.has('--all'),
        notify: booleans.has('--notify'),
        today,
      }),
    );
  } else {
    const id = positional[0];
    if (id === undefined) throw new CliUsageError(decideUsage);
    const row = closeDecision(
      root,
      id,
      need('--by'),
      need('--decision'),
      today,
    );
    process.stdout.write(`${row.id} closed by ${row.decidedBy}\n`);
  }
}
