// Bind deterministic review inputs to one immutable head before judges inspect behaviour.
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createLedger } from '../src/ledger/index.ts';
import { loadLiveContract } from '../src/ledger/live.ts';
import { createPaperclipCliTransport } from '../src/ledger/paperclip-cli.ts';

const gitHubPrSchema = z.object({
  title: z.string(),
  headRefOid: z.string().regex(/^[a-f0-9]{40,64}$/i),
});
const gitHubStatusSchema = z.array(
  z.object({
    context: z.string(),
    state: z.string(),
    creator: z.object({ login: z.string().min(1) }).nullable(),
    updated_at: z.string().optional(),
  }),
);

function argument(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing ${flag}`);
  return value;
}

function command(binary, args, { cwd, input } = {}) {
  const result = spawnSync(binary, args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      result.error?.message || result.stderr.trim() || `${binary} failed`,
    );
  return result.stdout.trim();
}

function repositoryFromRemote(remote) {
  const match =
    /^(?:https?|ssh|git):\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(
      remote,
    ) ?? /^[^@]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(remote);
  if (!match?.[1])
    throw new Error('unable to parse origin remote owner/repository');
  return match[1].replace(/\.git$/i, '').toLowerCase();
}

function conventionalTicket(title) {
  const match = /^[a-z][a-z0-9-]*(?:\([^)]+\))?!?: .+ \((LON-\d+)\)$/u.exec(
    title,
  );
  return match?.[1] ?? null;
}

function trailerValues(message, name, cwd) {
  const trailers = command('git', ['interpret-trailers', '--parse'], {
    cwd,
    input: message,
  });
  return trailers.split('\n').flatMap((line) => {
    const match = new RegExp(`^${name}:\\s*(.*?)\\s*$`, 'u').exec(line);
    return match ? [match[1] ?? ''] : [];
  });
}

export function evaluateMetadata({
  title,
  commitMessage,
  paperclipDescription,
  repo,
}) {
  const reasons = [];
  const ticket = conventionalTicket(title);
  if (!ticket)
    reasons.push('PR title is not Conventional or lacks a trailing (LON-<n>)');

  const tickets = trailerValues(commitMessage, 'Ticket', repo);
  const tasks = trailerValues(commitMessage, 'R1-task', repo);
  if (tickets.length !== 1 || tickets[0] !== ticket)
    reasons.push(
      'head commit must contain exactly one matching Ticket trailer',
    );
  if (tasks.length !== 1 || !tasks[0])
    reasons.push(
      'head commit must contain exactly one non-empty R1-task trailer',
    );

  const mapping = [
    ...paperclipDescription.matchAll(/^R1-task:\s*(.*?)\s*$/gmu),
  ];
  if (mapping.length !== 1 || mapping[0]?.[1] !== tasks[0])
    reasons.push(
      'live Paperclip R1-task line does not match the head commit trailer',
    );

  return { ticket, task: tasks[0] ?? null, reasons };
}

function parseOptions(args) {
  return {
    repo: resolve(argument('--repo', args)),
    base: argument('--base', args),
    head: argument('--head', args),
    pr: argument('--pr', args),
    output: resolve(argument('--output', args)),
  };
}

async function readPaperclipTask(ticket, repo) {
  const origin = command('git', ['remote', 'get-url', 'origin'], { cwd: repo });
  const transport = createPaperclipCliTransport();
  const ledger = createLedger({ session: '', transport });
  try {
    const live = await loadLiveContract(ledger, ticket, { origin });
    return live.contract.description;
  } finally {
    await transport.cancelAll?.();
  }
}

function readPullRequest(number, repository) {
  const output = command('gh', [
    'pr',
    'view',
    number,
    '--repo',
    repository,
    '--json',
    'title,headRefOid',
  ]);
  return gitHubPrSchema.parse(JSON.parse(output));
}

function readHeadStatus(repository, head) {
  const output = command('gh', [
    'api',
    `repos/${repository}/commits/${head}/statuses`,
  ]);
  const statuses = gitHubStatusSchema.parse(JSON.parse(output));
  const match = statuses
    .filter((status) => status.context === 'krn/gate-local')
    .sort((left, right) =>
      (right.updated_at ?? '').localeCompare(left.updated_at ?? ''),
    )[0];
  return match
    ? {
        context: match.context,
        state: match.state,
        creator: match.creator?.login ?? null,
      }
    : { context: 'krn/gate-local', state: null, creator: null };
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(
      'Usage: node scripts/pr-preflight.mjs --repo <path> --base <ref> --head <ref> --pr <number> --output <path>\n',
    );
    return 0;
  }
  const options = parseOptions(args);
  if (!/^\d+$/u.test(options.pr) || Number(options.pr) < 1)
    throw new Error('--pr must be a positive integer');

  const head = command(
    'git',
    ['rev-parse', '--verify', `${options.head}^{commit}`],
    {
      cwd: options.repo,
    },
  );
  const base = command(
    'git',
    ['rev-parse', '--verify', `${options.base}^{commit}`],
    {
      cwd: options.repo,
    },
  );
  const repository = repositoryFromRemote(
    command('git', ['remote', 'get-url', 'origin'], { cwd: options.repo }),
  );
  const reasons = [];
  let pr = { title: '', headRefOid: '' };
  try {
    pr = readPullRequest(options.pr, repository);
  } catch {
    reasons.push(`unable to read GitHub PR ${options.pr}`);
  }
  if (pr.headRefOid && pr.headRefOid.toLowerCase() !== head.toLowerCase())
    reasons.push('PR head does not match the requested exact head SHA');

  const commitMessage = command('git', ['show', '-s', '--format=%B', head], {
    cwd: options.repo,
  });
  const titleTicket = conventionalTicket(pr.title);
  let paperclipDescription = '';
  if (titleTicket) {
    try {
      paperclipDescription = await readPaperclipTask(titleTicket, options.repo);
    } catch {
      reasons.push(`unable to read live Paperclip issue ${titleTicket}`);
    }
  }
  const metadata = evaluateMetadata({
    title: pr.title,
    commitMessage,
    paperclipDescription,
    repo: options.repo,
  });
  reasons.push(...metadata.reasons);

  const trees = { src: null, test: null };
  for (const tree of ['src', 'test']) {
    try {
      trees[tree] = command('git', ['rev-parse', `${head}:${tree}`], {
        cwd: options.repo,
      });
    } catch {
      reasons.push(`unable to read ${tree} tree from exact head`);
    }
  }
  let status;
  try {
    status = readHeadStatus(repository, head);
  } catch {
    status = { context: 'krn/gate-local', state: null, creator: null };
    reasons.push('unable to read krn/gate-local status for exact head');
  }
  if (status.state !== 'success')
    reasons.push('krn/gate-local status is not success on exact head');
  if (!status.creator) reasons.push('krn/gate-local status has no creator');

  const verdict = {
    version: 1,
    verdict: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    pr: Number(options.pr),
    repository,
    base,
    head,
    ticket: metadata.ticket,
    task: metadata.task,
    trees,
    status,
  };
  await writeFile(
    options.output,
    `${JSON.stringify(verdict, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${head}\n`);
  return verdict.verdict === 'pass' ? 0 : 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'preflight failed'}\n`,
    );
    process.exitCode = 1;
  }
}
