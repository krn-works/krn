// PR admission reads are pinned to the supplied repository and exact head; no Git writes occur.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  gateAdmissionPolicyFromBase,
  matchesGateCheckRun,
} from '../src/deliver/admission-policy.ts';
import {
  currentReviewAttempts,
  seriesRecordPaths,
  verifyReviewBinding,
} from '../src/flow/series.ts';
import {
  deterministicCauses,
  isBlockingPrepassOnly,
  newReviewRecordSchema,
  pullRequestSchema,
  seriesIdentitySchema,
} from '../src/flow/types.ts';
import { isTaskId, parseTaskDocument } from '../src/task/record.ts';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_REVIEW_BYTES = 1024 * 1024;
const MAX_CHECK_RUN_PAGES = 10;
const CHECK_RUN_PAGE_SIZE = 100;
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
const ticketSchema = z.string().refine(isTaskId);
const text = z.string().trim().min(1);
const argsSchema = z
  .object({
    repo: z.string().min(1),
    base: sha,
    head: sha,
    pr: z.string().regex(/^[1-9]\d*$/u),
  })
  .strict();
const pullSchema = pullRequestSchema.extend({
  title: z.string().min(1),
});
const checkRunsSchema = z.array(
  z
    .object({
      id: z.number().int().positive(),
      name: z.string().min(1),
      head_sha: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/iu),
      app: z
        .object({
          id: z.number().int().positive().optional(),
          slug: z.string().optional(),
        })
        .nullable(),
      status: z.string().min(1),
      conclusion: z.string().nullable(),
      html_url: z.string().url(),
      started_at: z.string().datetime({ offset: true }).nullable().optional(),
      completed_at: z.string().datetime({ offset: true }).nullable().optional(),
    })
    .passthrough(),
);
const checkRunPageSchema = z
  .object({
    total_count: z.number().int().nonnegative(),
    check_runs: checkRunsSchema.max(CHECK_RUN_PAGE_SIZE),
  })
  .passthrough();
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

function gitBytes(repo, args) {
  const env = { ...process.env };
  for (const key of GIT_OVERRIDES) delete env[key];
  const child = spawnSync('git', args, {
    cwd: repo,
    env,
    encoding: 'buffer',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
  if (child.error || child.status !== 0 || !Buffer.isBuffer(child.stdout))
    return err('process failed');
  return ok(child.stdout);
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

function readCheckRuns(repo, slug, head) {
  const runs = [];
  for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
    const result = ghJson(
      repo,
      `repos/${slug}/commits/${head}/check-runs?filter=all&per_page=${CHECK_RUN_PAGE_SIZE}&page=${page}`,
    );
    const parsed = result.ok
      ? checkRunPageSchema.safeParse(result.value)
      : undefined;
    if (!parsed?.success) return err('invalid check-run page');
    const { total_count: total, check_runs: current } = parsed.data;
    if (total > MAX_CHECK_RUN_PAGES * CHECK_RUN_PAGE_SIZE)
      return err('check-run pagination bound exceeded');
    runs.push(...current);
    if (current.length < CHECK_RUN_PAGE_SIZE)
      return runs.length >= total
        ? ok(runs)
        : err('incomplete check-run pagination');
    if (runs.length >= total) return ok(runs);
  }
  return err('check-run pagination bound exceeded');
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
    /^[a-z][a-z\d-]*(?:\([^)]+\))?!?: .+ \((?<ticket>[^()]+)\)$/u.exec(title)
      ?.groups?.ticket;
  return ticket !== undefined && isTaskId(ticket) ? ticket : undefined;
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

// Mirror record.ts's realpath/regular-file boundary, with bounded reads.
// JSON.parse rejects BOM; CRLF is valid JSON. Hash the original bytes in both cases.
function readReviewBytes(root, head, recordPath) {
  let directory = root;
  const parts = recordPath ? [] : ['.krn', 'runs', 'review', head];
  if (recordPath) {
    // Common series paths are derived and checked by their owner above.
    directory = resolve(recordPath, '..');
  }
  for (const part of parts) {
    directory = join(directory, part);
    let stat;
    try {
      stat = lstatSync(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return ok(undefined);
      return err('review record directory could not be read');
    }
    if (!stat.isDirectory() || realpathSync(directory) !== directory)
      return err(
        'review record directory is unsafe (symlink or non-directory)',
      );
  }
  const path = recordPath ?? join(directory, 'record.json');
  let descriptor;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      return err('review record must be a regular file without symlinks');
    if (stat.size > MAX_REVIEW_BYTES)
      return err('review record exceeds the 1 MiB size bound');
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
      return err('review record must remain the same regular file');
    if (opened.size > MAX_REVIEW_BYTES)
      return err('review record exceeds the 1 MiB size bound');
    const bytes = Buffer.alloc(MAX_REVIEW_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_REVIEW_BYTES)
      return err('review record exceeds the 1 MiB size bound');
    return ok({ path, bytes: bytes.subarray(0, length) });
  } catch (error) {
    if (error.code === 'ENOENT') return ok(undefined);
    return err('review record could not be read safely');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function stripUnrecognizedKeys(value, issues) {
  const stripped = structuredClone(value);
  for (const issue of issues) {
    if (
      issue.code !== 'unrecognized_keys' ||
      !Array.isArray(issue.keys) ||
      !issue.keys.every((key) => typeof key === 'string')
    )
      return undefined;
    let target = stripped;
    for (const segment of issue.path) {
      if (
        target === null ||
        typeof target !== 'object' ||
        !Object.hasOwn(target, segment)
      )
        return undefined;
      target = target[segment];
    }
    if (target === null || typeof target !== 'object' || Array.isArray(target))
      return undefined;
    for (const key of issue.keys) delete target[key];
  }
  return stripped;
}

function addReviewerToolBaseReason(repo, base, toolSha, path, reasons) {
  if (
    sha.safeParse(toolSha).success &&
    !git(repo, ['merge-base', '--is-ancestor', toolSha, base]).ok
  )
    reasons.add(
      `review record came from reviewer code ${toolSha} outside the PR base; re-run the review with the base checkout's bin/krn: ${path}`,
    );
}

function reviewEvidence(repo, input, reasons, identity) {
  const worktrees = readGit(
    repo,
    ['worktree', 'list', '--porcelain', '-z'],
    text,
    'registered review worktrees could not be read',
    reasons,
  );
  const roots = new Set([repo]);
  for (const field of worktrees?.split('\0') ?? []) {
    if (field.startsWith('worktree '))
      roots.add(field.slice('worktree '.length));
  }
  const records = [];
  const paths = new Map(
    [...roots].map((root) => [
      join(root, '.krn', 'runs', 'review', input.head, 'record.json'),
      root,
    ]),
  );
  let expected = [];
  if (identity) {
    try {
      expected = currentReviewAttempts(repo, identity, input.head);
      for (const path of seriesRecordPaths(repo, identity, input.head))
        paths.set(path, undefined);
    } catch (error) {
      reasons.add(
        `review series state unavailable or invalid: ${error.message}`,
      );
    }
  }
  const observed = new Set();
  const latest = expected.at(-1);
  const hashes = new Set();
  for (const [path, root] of paths) {
    let found;
    try {
      found = readReviewBytes(
        root ?? repo,
        input.head,
        root === undefined ? path : undefined,
      );
    } catch {
      found = err('review record directory could not be read safely');
    }
    if (!found.ok) {
      reasons.add(`${found.error}: ${path}`);
      continue;
    }
    if (!found.value) continue;
    const { bytes } = found.value;
    const evidence = {
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    if (hashes.has(evidence.sha256)) continue;
    hashes.add(evidence.sha256);
    records.push(evidence);
    let source;
    try {
      source = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      reasons.add(`review record is not valid UTF-8: ${path}`);
      continue;
    }
    let json;
    try {
      json = JSON.parse(source);
    } catch {
      reasons.add(`review record is not valid JSON: ${path}`);
      continue;
    }
    const boundary = z
      .object({ headSha: sha, base: z.string() })
      .safeParse(json);
    if (boundary.success) {
      if (boundary.data.headSha.toLowerCase() !== input.head)
        reasons.add(
          `review record head does not match the exact head: ${path}`,
        );
      if (!sha.safeParse(boundary.data.base).success) {
        reasons.add(`review base must be a full commit ID: ${path}`);
      } else {
        for (const [name, commit] of [
          ['base', input.base],
          ['head', input.head],
        ]) {
          if (
            !git(repo, [
              'merge-base',
              '--is-ancestor',
              boundary.data.base,
              commit,
            ]).ok
          )
            reasons.add(
              `review base must be an ancestor of --${name}: ${path}`,
            );
        }
      }
    }
    let parsed = newReviewRecordSchema.safeParse(json);
    if (
      !parsed.success &&
      parsed.error.issues.every((issue) => issue.code === 'unrecognized_keys')
    ) {
      const stripped = stripUnrecognizedKeys(json, parsed.error.issues);
      parsed = newReviewRecordSchema.safeParse(stripped);
    }
    if (!parsed.success) {
      reasons.add(`review record does not satisfy the strict schema: ${path}`);
      // Ship never guesses an unknown value; only the trusted base reviewer
      // can produce a record the base schema can verify.
      addReviewerToolBaseReason(repo, input.base, json?.toolSha, path, reasons);
      continue;
    }
    const record = parsed.data;
    addReviewerToolBaseReason(repo, input.base, record.toolSha, path, reasons);
    try {
      if (!identity) throw new Error('authoritative PR identity unavailable');
      verifyReviewBinding(repo, record, identity);
      observed.add(record.attempt.ordinal);
    } catch (error) {
      reasons.add(
        `review PR/reservation binding refused: ${error.message}: ${path}`,
      );
    }
    if (
      record.attempt &&
      latest &&
      record.attempt.ordinal < latest.ordinal &&
      record.panelVerdict === 'INCOMPLETE'
    ) {
      // Consumption stays visible in the series. Only the later attempt must
      // complete, including when a crashed/incomplete attempt used this head.
      records.pop();
      continue;
    }
    for (const check of deterministicCauses(
      record.redFirst,
      record.contracts ?? [],
    ))
      reasons.add(
        `deterministic red-first ${check.verdict}: ${check.path}: ${check.cause}`,
      );
    Object.assign(evidence, {
      headSha: record.headSha,
      base: record.base,
      panelVerdict: record.panelVerdict,
      verdict: record.panelVerdict,
      panel: record.panel,
      judges: record.judges.map(({ role, state, verdict, model }) => ({
        role,
        state,
        verdict,
        model,
      })),
      lensSha256: record.lensSha256,
      toolSha: record.toolSha,
      redFirstCount: record.redFirst.length,
      ...(record.override ? { override: record.override } : {}),
    });
    const blockingPrepass = isBlockingPrepassOnly(record);
    const hasFailure =
      blockingPrepass ||
      record.judges.some(
        (judge) => judge.state === 'complete' && judge.verdict === 'FAIL',
      );
    if (record.override) {
      if (
        !blockingPrepass &&
        (record.panel?.partial !== false ||
          record.judges.some((judge) => judge.state !== 'complete'))
      )
        reasons.add(
          `current exact-head review is incomplete despite override: ${path}`,
        );
      if (!hasFailure)
        reasons.add(`review override requires a complete FAIL: ${path}`);
      else evidence.verdict = 'overridden';
    } else if (
      record.panelVerdict !== 'PASS' ||
      record.panel?.partial !== false ||
      !record.judges.every(
        (judge) => judge.state === 'complete' && judge.verdict === 'PASS',
      )
    ) {
      reasons.add(
        `review panel is ${record.panelVerdict ?? 'INCOMPLETE'} without override: ${path}`,
      );
    }
  }
  if (latest && !observed.has(latest.ordinal))
    reasons.add(
      'current exact-head review attempt is incomplete (record missing or binding invalid)',
    );
  if (records.length === 0) reasons.add('exact-head review record is missing');
  return records;
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

  let canonicalBase = input.base;
  let canonicalHead = input.head;
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
    if (found) {
      const canonical = found.toLowerCase();
      if (canonical !== value.toLowerCase())
        reasons.add(`${name} must be a full exact commit ID`);
      if (name === 'base') canonicalBase = canonical;
      else canonicalHead = canonical;
    }
  }
  report.base = canonicalBase;
  report.head = canonicalHead;
  for (const [field, path] of [
    ['srcTreeSha', 'src'],
    ['testTreeSha', 'test'],
  ]) {
    const tree = readGit(
      repo,
      ['rev-parse', `${canonicalHead}:${path}`],
      outputSha,
      `head commit has no readable ${path}/ tree`,
      reasons,
    );
    if (tree) report[field] = tree;
  }
  const message = readGit(
    repo,
    ['show', '-s', '--format=%B', canonicalHead],
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
  }

  report.reviewRecords = [];
  let identity;
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
      try {
        if (pull.number !== input.pr || pull.head.sha !== canonicalHead)
          throw new Error(
            'authoritative PR number/head does not match request',
          );
        // Admission checks base ancestry below; the reviewed base need not equal the moved PR base.
        identity = seriesIdentitySchema.parse({
          schemaVersion: 1,
          repository: pull.base.repo.full_name,
          pr: input.pr,
          baseRef: pull.base.ref,
        });
      } catch (error) {
        reasons.add(`authoritative PR binding refused: ${error.message}`);
      }
      Object.assign(report, {
        title: pull.title,
        prBase: pull.base.sha,
        prHead: pull.head.sha,
      });
      const ticket = extractTicket(pull.title);
      if (!ticket)
        reasons.add('PR title must be Conventional and end with a task id');
      else {
        report.ticket = ticket;
        if (report.ticketTrailer !== ticket)
          reasons.add(
            'Ticket trailer must match the task id captured from the PR title',
          );
        const taskFile = gitBytes(repo, [
          'show',
          `${canonicalHead}:tasks/${ticket}.json`,
        ]);
        if (!taskFile.ok) {
          reasons.add(`task ${ticket} is missing from the PR head`);
        } else {
          const task = parseTaskDocument(taskFile.value);
          if (
            task.findings.length > 0 ||
            task.record === undefined ||
            task.record.id !== ticket
          ) {
            const findings = task.findings.join(', ');
            reasons.add(
              `task ${ticket} at the PR head is invalid${findings ? `: ${findings}` : ''}`,
            );
          }
        }
      }
      if (
        !git(repo, [
          'merge-base',
          '--is-ancestor',
          pull.base.sha.toLowerCase(),
          canonicalBase,
        ]).ok
      )
        reasons.add('PR base SHA is not in the requested base history');
      if (pull.head.sha.toLowerCase() !== canonicalHead)
        reasons.add('PR head SHA does not match the requested exact head');
    }

    const checkRuns = await readValue(
      dependencies.readCheckRuns ?? readCheckRuns,
      [repo, slug, canonicalHead],
      checkRunsSchema,
      'GitHub head check-runs could not be read',
      reasons,
    );
    if (checkRuns) {
      let gatePolicy;
      try {
        gatePolicy = gateAdmissionPolicyFromBase(pull.base.sha, (args) => {
          const result = git(repo, args);
          if (!result.ok) throw new Error('base policy git read failed');
          return result.value;
        });
      } catch {
        reasons.add(
          'authoritative PR base gate admission policy is invalid or unavailable',
        );
      }
      const gate = checkRuns
        .filter(
          (check) =>
            gatePolicy && matchesGateCheckRun(check, canonicalHead, gatePolicy),
        )
        .sort((a, b) => b.id - a.id)[0];
      if (!gate) reasons.add('exact-head configured gate check-run is missing');
      else {
        report.gateCheckRun = {
          id: gate.id,
          url: gate.html_url,
          status: gate.status,
          conclusion: gate.conclusion,
          name: gate.name,
          head: gate.head_sha,
          appId: gate.app?.id ?? null,
        };
        if (gate.status !== 'completed' || gate.conclusion !== 'success')
          reasons.add(
            'latest exact-head Actions gate check-run is not completed/success',
          );
      }
    }
  }
  report.reviewRecords = reviewEvidence(
    repo,
    { ...input, base: canonicalBase, head: canonicalHead },
    reasons,
    identity,
  );
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
