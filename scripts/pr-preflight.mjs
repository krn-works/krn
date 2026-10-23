// PR admission reads are pinned to the supplied repository and exact head; no Git or Paperclip writes occur.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parsePaperclipIssue } from '../src/core/paperclip.ts';
import {
  parseDeliveryTicket,
  parseWorkReference,
} from '../src/ledger/delivery.ts';
import { createPaperclipCliTransport } from '../src/ledger/paperclip-cli.ts';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const GIT_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
];
const sha = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/iu);
const outputSha = z.string().trim().pipe(sha);
const taskSchema = z.string().regex(/^(?:R1-\d+|LON-\d+|none)$/u);
const ticketSchema = z
  .string()
  .refine(
    (value) => value.startsWith('LON-') && parseDeliveryTicket(value) === value,
  );
const text = z.string().trim().min(1);
const argsSchema = z
  .object({
    repo: z.string().min(1),
    base: sha,
    head: sha,
    pr: z.string().regex(/^[1-9]\d*$/u),
  })
  .strict();
const pullSchema = z.object({
  title: z.string().min(1),
  base: z.object({ sha }),
  head: z.object({ sha }),
});
const statusesSchema = z.array(
  z.object({
    context: z.string().min(1),
    state: z.enum(['error', 'failure', 'pending', 'success']),
    creator: z.object({ login: z.string().min(1) }).nullable(),
    description: z.string().nullable().optional(),
    created_at: z.string().datetime({ offset: true }).optional(),
    updated_at: z.string().datetime({ offset: true }).optional(),
  }),
);
const ok = (value) => ({ ok: true, value });
const err = (error) => ({ ok: false, error });

function parseArguments(argv) {
  const values = {};
  const flags = new Set(['--repo', '--base', '--head', '--pr']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!flags.has(key) || Object.hasOwn(values, key.slice(2)))
      return err(
        'usage: pr-preflight.mjs --repo <path> --base <sha> --head <sha> --pr <number>',
      );
    if (!value || value.startsWith('--'))
      return err(`missing value for ${key}`);
    values[key.slice(2)] = value;
  }
  const parsed = argsSchema.safeParse(values);
  return parsed.success
    ? ok({ ...parsed.data, pr: Number(parsed.data.pr) })
    : err(
        'repo, full base/head commit IDs, and a positive PR number are required',
      );
}

function run(command, args, cwd, env, input) {
  const child = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
  if (child.error || child.status !== 0) return err('process failed');
  const parsed = z.string().safeParse(child.stdout);
  return parsed.success
    ? ok(parsed.data)
    : err('process returned invalid text');
}

function git(repo, args, input) {
  const env = { ...process.env };
  for (const key of GIT_OVERRIDES) delete env[key];
  return run('git', args, repo, env, input);
}

function checked(result, schema, reason, reasons) {
  const parsed =
    result?.ok === true ? schema.safeParse(result.value) : undefined;
  if (!parsed?.success) reasons.add(reason);
  else return parsed.data;
}

function readGit(repo, args, schema, reason, reasons, input) {
  return checked(git(repo, args, input), schema, reason, reasons);
}

function ghJson(repo, resource) {
  const result = run('gh', ['api', resource], repo, process.env);
  if (!result.ok) return result;
  try {
    return ok(JSON.parse(result.value));
  } catch {
    return err('invalid JSON');
  }
}

async function readValue(read, args, schema, reason, reasons) {
  try {
    const result = await read(...args);
    return checked(result, schema, reason, reasons);
  } catch {
    reasons.add(reason);
  }
}

function githubSlug(remote) {
  return /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/iu.exec(
    remote,
  )?.[1];
}

function extractTicket(title) {
  const ticket =
    /^[a-z][a-z\d-]*(?:\([^)]+\))?!?: .+ \((?<ticket>LON-\d+)\)$/u.exec(title)
      ?.groups?.ticket;
  return ticket !== undefined && parseDeliveryTicket(ticket) === ticket
    ? ticket
    : undefined;
}

function trailer(lines, name, schema, optional = false) {
  const values = lines
    .filter((line) => line.startsWith(`${name}:`))
    .map((line) => line.slice(name.length + 1).trim());
  if (values.length > 1 || (!optional && values.length !== 1))
    return err(
      `head commit must contain ${optional ? 'at most one' : 'exactly one'} ${name} trailer`,
    );
  if (values.length === 0) return ok(undefined);
  const parsed = schema.safeParse(values[0]);
  return parsed.success
    ? ok(parsed.data)
    : err(`head commit ${name} trailer is malformed`);
}

function paperclipTask(description) {
  const lines = description
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('R1-task:'));
  if (lines.length > 1)
    return err('Paperclip description must contain at most one R1-task line');
  if (lines.length === 0) return ok(undefined);
  const value = parseWorkReference(lines[0] ?? '');
  const parsed = taskSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err('Paperclip R1-task line is malformed');
}

function latestGateLocal(statuses) {
  const gate = statuses
    .filter((status) => status.context === 'krn/gate-local')
    .sort(
      (a, b) =>
        (Date.parse(b.created_at ?? b.updated_at ?? '') || 0) -
        (Date.parse(a.created_at ?? a.updated_at ?? '') || 0),
    )[0];
  return gate ? ok(gate) : err('exact-head krn/gate-local status is missing');
}

function hasZeroIsolationSkips(description) {
  const counts = [...description.matchAll(/\b(\d+)\s+isolation skips\b/gu)];
  return counts.length === 1 && Number(counts[0]?.[1]) === 0;
}

async function readPaperclipDescription(ticket) {
  const transport = createPaperclipCliTransport();
  try {
    const issue = parsePaperclipIssue(await transport.readIssue(ticket));
    if (!issue.ok)
      return err(
        `Paperclip issue ${ticket} could not be read: invalid issue response`,
      );
    if (issue.value.id !== ticket && issue.value.identifier !== ticket)
      return err(
        `Paperclip issue ${ticket} could not be read: issue identity mismatch`,
      );
    return ok(issue.value.description);
  } catch {
    return err(
      `Paperclip issue ${ticket} could not be read: Paperclip CLI read failed`,
    );
  } finally {
    if (transport.cancelAll) await transport.cancelAll().catch(() => {});
  }
}

async function readPaperclipDescriptionValue(read, ticket, reasons) {
  const fallback = `Paperclip issue ${ticket} could not be read through the ledger CLI`;
  const safeFailures = new Set([
    `Paperclip issue ${ticket} could not be read: invalid issue response`,
    `Paperclip issue ${ticket} could not be read: issue identity mismatch`,
    `Paperclip issue ${ticket} could not be read: Paperclip CLI read failed`,
  ]);
  let result;
  try {
    result = await read(ticket);
  } catch {
    reasons.add(fallback);
    return;
  }
  if (result?.ok === false) {
    reasons.add(safeFailures.has(result.error) ? result.error : fallback);
    return;
  }
  return checked(result, z.string(), fallback, reasons);
}

export async function runPreflight(input, dependencies = {}) {
  const report = {
    verdict: 'fail',
    reasons: [],
    repo: input.repo,
    base: input.base,
    head: input.head,
    pr: input.pr,
  };
  const reasons = new Set();
  const finish = () => {
    report.reasons = [...reasons];
    if (!reasons.size) report.verdict = 'pass';
    return report;
  };
  let repo;
  try {
    repo = realpathSync(resolve(input.repo));
  } catch {
    reasons.add('target repository path is unavailable');
    return finish();
  }

  const root = readGit(
    repo,
    ['rev-parse', '--show-toplevel'],
    text,
    'target path is not a Git repository',
    reasons,
  );
  if (root && resolve(root) !== repo)
    reasons.add('--repo must be the repository root');
  const remote = readGit(
    repo,
    ['remote', 'get-url', 'origin'],
    text,
    'origin remote could not be read',
    reasons,
  );
  const slug = remote && githubSlug(remote);
  if (remote && !slug)
    reasons.add('origin remote must identify a GitHub owner/repository');

  for (const [name, value] of [
    ['base', input.base],
    ['head', input.head],
  ]) {
    const found = readGit(
      repo,
      ['rev-parse', '--verify', `${value}^{commit}`],
      outputSha,
      `${name} commit is not present in the target repository`,
      reasons,
    );
    if (found && found.toLowerCase() !== value.toLowerCase())
      reasons.add(`${name} must be a full exact commit ID`);
  }
  for (const [field, path] of [
    ['srcTreeSha', 'src'],
    ['testTreeSha', 'test'],
  ]) {
    const tree = readGit(
      repo,
      ['rev-parse', `${input.head}:${path}`],
      outputSha,
      `head commit has no readable ${path}/ tree`,
      reasons,
    );
    if (tree) report[field] = tree;
  }
  const message = readGit(
    repo,
    ['show', '-s', '--format=%B', input.head],
    z.string().max(256 * 1024),
    'head commit message could not be read',
    reasons,
  );
  if (message !== undefined) {
    const body =
      readGit(
        repo,
        ['interpret-trailers', '--parse'],
        z.string().max(256 * 1024),
        'head commit trailers could not be parsed',
        reasons,
        message,
      ) ?? '';
    const lines = body.split(/\r?\n/u);
    const ticketTrailer = trailer(lines, 'Ticket', ticketSchema);
    if (ticketTrailer.ok) report.ticketTrailer = ticketTrailer.value;
    else reasons.add(ticketTrailer.error);
    const r1TaskTrailer = trailer(lines, 'R1-task', taskSchema, true);
    if (r1TaskTrailer.ok && r1TaskTrailer.value !== undefined)
      report.r1TaskTrailer = r1TaskTrailer.value;
    else if (!r1TaskTrailer.ok) reasons.add(r1TaskTrailer.error);
  }

  if (slug) {
    const pullRead =
      dependencies.readPull ??
      ((path, repoName, pr) => ghJson(path, `repos/${repoName}/pulls/${pr}`));
    const pull = await readValue(
      pullRead,
      [repo, slug, input.pr],
      pullSchema,
      'GitHub pull request could not be read',
      reasons,
    );
    if (pull) {
      Object.assign(report, {
        title: pull.title,
        prBase: pull.base.sha,
        prHead: pull.head.sha,
      });
      const ticket = extractTicket(pull.title);
      if (!ticket)
        reasons.add('PR title must be Conventional and end with (LON-<n>)');
      else {
        report.ticket = ticket;
        if (report.ticketTrailer !== ticket)
          reasons.add(
            'Ticket trailer must match the LON ticket captured from the PR title',
          );
        const issueRead =
          dependencies.readPaperclipDescription ?? readPaperclipDescription;
        const description = await readPaperclipDescriptionValue(
          issueRead,
          ticket,
          reasons,
        );
        if (description !== undefined) {
          const mapping = paperclipTask(description);
          if (mapping.ok) {
            if (mapping.value === undefined) {
              if (report.r1TaskTrailer !== undefined)
                reasons.add(
                  'R1-task trailer must be omitted when the Paperclip description has no R1-task line',
                );
            } else {
              report.paperclipR1Task = mapping.value;
              if (report.r1TaskTrailer !== mapping.value)
                reasons.add(
                  'R1-task trailer must match the Paperclip description',
                );
            }
          } else reasons.add(mapping.error);
        }
      }
      if (pull.base.sha.toLowerCase() !== input.base.toLowerCase())
        reasons.add('PR base SHA does not match the requested base');
      if (pull.head.sha.toLowerCase() !== input.head.toLowerCase())
        reasons.add('PR head SHA does not match the requested exact head');
    }

    const statusRead =
      dependencies.readStatuses ??
      ((path, repoName, head) =>
        ghJson(path, `repos/${repoName}/commits/${head}/statuses`));
    const statuses = await readValue(
      statusRead,
      [repo, slug, input.head],
      statusesSchema,
      'GitHub commit statuses could not be read',
      reasons,
    );
    if (statuses) {
      const found = latestGateLocal(statuses);
      if (!found.ok) reasons.add(found.error);
      else {
        const status = found.value;
        const creator = status.creator?.login ?? null;
        report.gateLocalStatus = {
          context: status.context,
          state: status.state,
          creator,
          description: status.description ?? null,
        };
        if (status.state !== 'success')
          reasons.add('exact-head krn/gate-local status is not success');
        if (!creator)
          reasons.add('exact-head krn/gate-local status has no creator');
        if (!status.description || !hasZeroIsolationSkips(status.description))
          reasons.add(
            'exact-head krn/gate-local status does not report zero isolation skips',
          );
      }
    }
  }
  return finish();
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  const report = parsed.ok
    ? await runPreflight(parsed.value)
    : { verdict: 'fail', reasons: [parsed.error] };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.verdict === 'pass' ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main();
