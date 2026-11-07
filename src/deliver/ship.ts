import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { CliUsageError } from '../cli/usage-error.ts';
import { gateAdmissionPolicyFromBase } from './admission-policy.ts';

export interface ShipProcessResult {
  ok: boolean;
  out: string;
  status?: number | null;
  errorCode?: string | null;
}
export type ShipRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout?: number; maxBuffer?: number },
) => ShipProcessResult;
const runProcess: ShipRunner = (command, args, options) => {
  const r = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
  });
  return {
    ok: r.status === 0 && !r.error,
    out: r.stdout ?? '',
    status: r.status,
    errorCode: r.error && 'code' in r.error ? String(r.error.code) : null,
  };
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{40}$/iu);
const prSchema = z.object({
  state: z.string(),
  baseRefName: z.string(),
  baseRefOid: sha,
  headRefOid: sha,
  mergeable: z.string(),
});
const checkSchema = z.object({
  id: z.number(),
  name: z.string(),
  head_sha: sha.optional(),
  created_at: z.string().optional(),
  status: z.string(),
  conclusion: z.string().nullable(),
  app: z
    .object({ id: z.number(), slug: z.string().optional() })
    .nullable()
    .optional(),
  app_id: z.number().optional(),
});
const statusSchema = z.object({
  context: z.string(),
  state: z.string(),
  created_at: z.string(),
});
const verifierSchema = z.object({
  verdict: z.literal('pass'),
  head: sha,
  base: sha,
  reasons: z.array(z.string()),
  reviewRecords: z
    .array(
      z
        .object({
          path: z.string().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/iu),
          headSha: sha,
          verdict: z.enum(['PASS', 'overridden']),
        })
        .passthrough(),
    )
    .min(1),
  gateCheckRun: z
    .object({
      id: z.number().int().positive(),
      url: z.string().min(1),
      status: z.literal('completed'),
      conclusion: z.literal('success'),
    })
    .passthrough(),
});
const judgesRequired = ['krn/judge-standards', 'krn/judge-spec'];
const clean = (s: string) =>
  [...(s.split(/[\r\n]/u)[0] ?? '')]
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join('');
class Refusal extends Error {}
function refuse(reason: string): never {
  throw new Refusal(clean(reason));
}
const usage =
  'usage: krn ship --repo OWNER/REPO --pr N --message-file FILE [--dry-run] [--json]';
function argumentsFor(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--json' || a === '--dry-run') continue;
    if (
      !['--repo', '--pr', '--message-file'].includes(a) ||
      values.has(a) ||
      !args[i + 1] ||
      args[i + 1]?.startsWith('--')
    )
      throw new CliUsageError(usage);
    values.set(a, args[++i] ?? '');
  }
  const repo = values.get('--repo') ?? '';
  const pr = Number(values.get('--pr'));
  const file = values.get('--message-file');
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo) ||
    !/^\d+$/u.test(values.get('--pr') ?? '') ||
    !Number.isSafeInteger(pr) ||
    pr < 1 ||
    !file
  )
    throw new CliUsageError(usage);
  return { repo, pr, file, dryRun: args.includes('--dry-run') };
}
function message(file: string, pr: number) {
  let raw: string;
  try {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.size > 65536) refuse('message file unavailable');
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return refuse('message file unavailable');
  }
  const text = raw.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
  const lines = text.replace(/\n+$/u, '').split('\n');
  const subject = lines[0] ?? '';
  const match = /^[a-z][a-z0-9-]*(?:\([^)]+\))?!?: .+ \(#([1-9]\d*)\)$/u.exec(
    subject,
  );
  if (!match || Number(match[1]) !== pr)
    refuse('subject must be a Conventional Commit ending in (#N) for this PR');
  if (lines[1] !== '' || lines.length < 3)
    refuse('message requires a blank line after the subject and a body');
  const paragraph = lines.slice(lines.lastIndexOf('') + 1);
  if (
    !paragraph.length ||
    paragraph.some((l) => !/^[A-Za-z][A-Za-z0-9-]*:\s*\S.*$/u.test(l))
  )
    refuse('message must end in one contiguous trailer block');
  for (const key of ['Ticket', 'Change-contract'])
    if (
      !paragraph.some((l) =>
        l.toLowerCase().startsWith(`${key.toLowerCase()}:`),
      )
    )
      refuse(`final trailer block requires ${key}:`);
  return { subject, body: text.slice(subject.length + 2) };
}
function safeDirectory(root: string, segments: string[]) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current);
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
    }
    if (!fs.lstatSync(current).isDirectory())
      refuse('delivery record unavailable; publication refused');
  }
  return current;
}
function atomicRecord(file: string, record: object) {
  try {
    if (!fs.lstatSync(file).isFile())
      refuse('delivery record unavailable; publication refused');
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
  }
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function githubRepo(url: string) {
  return /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/|(?:[^/@:]+@)?github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/iu
    .exec(url)?.[1]
    ?.toLowerCase();
}

/** The pinned Node under the mise data directory, as bin/krn resolves it. */
function pinnedNode(version: string) {
  const node = path.join(
    process.env.MISE_DATA_DIR || path.join(os.homedir(), '.local/share/mise'),
    'installs/node',
    version,
    'bin/node',
  );
  try {
    fs.accessSync(node, fs.constants.X_OK);
    return node;
  } catch {
    return undefined;
  }
}

/** Merge authority runs policy from the leased base, never from the candidate head. */
export async function ship(
  args: string[],
  runtime: {
    root?: string;
    run?: ShipRunner;
    now?: () => string;
    pinnedNode?: (version: string) => string | undefined;
  } = {},
) {
  const options = argumentsFor(args);
  const run = runtime.run ?? runProcess;
  const now = runtime.now ?? (() => new Date().toISOString());
  const startedAt = now();
  let root = path.resolve(runtime.root ?? process.cwd());
  const gitResult = (argv: string[], cwd = root) =>
    run('git', ['-C', cwd, ...argv], { cwd });
  const git = (argv: string[], cwd = root) => {
    const r = gitResult(argv, cwd);
    if (!r.ok) throw new Error('git command failed');
    return r.out.trim();
  };
  const json = (argv: string[]): unknown => {
    try {
      const r = run('gh', argv, { cwd: root });
      return r.ok ? JSON.parse(r.out) : null;
    } catch {
      return null;
    }
  };
  const readPr = () => {
    const p = prSchema.safeParse(
      json([
        'pr',
        'view',
        String(options.pr),
        '--repo',
        options.repo,
        '--json',
        'state,baseRefName,baseRefOid,headRefOid,mergeable',
      ]),
    );
    if (!p.success) refuse('PR read failed');
    return p.data;
  };
  try {
    try {
      root = git(['rev-parse', '--show-toplevel']);
    } catch {
      refuse('current directory is not a Git repository');
    }
    const messagePath = path.resolve(
      runtime.root ?? process.cwd(),
      options.file,
    );
    const parsedMessage = message(messagePath, options.pr);
    const pr = readPr();
    const head = pr.headRefOid;
    if (pr.state !== 'OPEN') refuse('PR is not open');
    for (const argv of [
      ['config', '--get-all', 'remote.origin.url'],
      ['remote', 'get-url', '--all', 'origin'],
      ['remote', 'get-url', '--push', '--all', 'origin'],
    ]) {
      const r = gitResult(argv);
      if (!r.ok || !r.out.trim()) refuse('origin does not match --repo');
      for (const url of r.out.trim().split(/\r?\n/u)) {
        if (githubRepo(url) === options.repo.toLowerCase()) continue;
        if (
          process.env.KRN_SHIP_ALLOW_LOCAL_ORIGIN === '1' &&
          (path.isAbsolute(url) || url.startsWith('file://'))
        )
          continue;
        refuse(
          path.isAbsolute(url) || url.startsWith('file://')
            ? 'origin destination does not match --repo'
            : 'origin does not match --repo',
        );
      }
    }
    const defaultBranch = () => {
      const r = gitResult(['ls-remote', '--symref', 'origin', 'HEAD']);
      const match = /^ref: refs\/heads\/([^\r\n\t]+)\tHEAD$/mu.exec(r.out);
      const fallback = z
        .object({ defaultBranchRef: z.object({ name: z.string() }) })
        .safeParse(
          match
            ? null
            : json([
                'repo',
                'view',
                '--repo',
                options.repo,
                '--json',
                'defaultBranchRef',
              ]),
        );
      const branch =
        match?.[1] ??
        (fallback.success ? fallback.data.defaultBranchRef.name : '');
      if (!branch || !gitResult(['check-ref-format', '--branch', branch]).ok)
        refuse('default branch unknown');
      return branch;
    };
    const branch = defaultBranch();
    if (pr.baseRefName !== branch)
      refuse(`PR base is not ${branch} (received ${pr.baseRefName})`);
    if (pr.mergeable !== 'MERGEABLE') refuse('PR is not mergeable');
    if (
      git(['ls-remote', 'origin', `refs/pull/${options.pr}/head`]).split(
        /\s+/u,
      )[0] !== head
    )
      refuse('origin does not match --repo');
    if (!gitResult(['check-ignore', '-q', '.krn/tmp']).ok)
      refuse('.krn/tmp is not ignored');
    const remoteBase = () => {
      const ref = `refs/heads/${branch}`;
      const [id, name] = git(['ls-remote', '--refs', 'origin', ref]).split(
        /\s+/u,
      );
      if (name !== ref || !sha.safeParse(id).success)
        refuse(`origin/${branch} unavailable`);
      return id ?? '';
    };
    const base = remoteBase();
    git([
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    if (
      git([
        'rev-parse',
        '--verify',
        `refs/remotes/origin/${branch}^{commit}`,
      ]) !== base
    )
      refuse(`origin/${branch} changed during pre-check`);
    git(['fetch', '--no-tags', 'origin', `refs/pull/${options.pr}/head`]);
    if (git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']) !== head)
      refuse('fetched PR head does not match the reviewed SHA');
    const selector = (() => {
      try {
        return gateAdmissionPolicyFromBase(base, git);
      } catch (error) {
        return refuse(
          error instanceof Error
            ? error.message
            : 'base CI admission policy lookup failed',
        );
      }
    })();
    const evidence = () => {
      const statuses = z
        .array(z.array(statusSchema))
        .safeParse(
          json([
            'api',
            '--paginate',
            '--slurp',
            `repos/${options.repo}/commits/${head}/statuses?per_page=100`,
          ]),
        );
      if (!statuses.success) refuse('commit statuses unavailable');
      const latest = statuses.data
        .flat()
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const judges = Object.fromEntries(
        judgesRequired.map((context) => [
          context,
          latest.find((s) => s.context === context)?.state ?? 'missing',
        ]),
      );
      for (const context of judgesRequired)
        if (judges[context] !== 'success')
          refuse(`required judge ${context} is ${judges[context]}`);
      const payload = json([
        'api',
        '--paginate',
        '--slurp',
        `repos/${options.repo}/commits/${head}/check-runs?per_page=100`,
      ]);
      const pages = z
        .array(z.object({ check_runs: z.array(checkSchema) }))
        .safeParse(Array.isArray(payload) ? payload : [payload]);
      if (!pages.success) refuse('check runs unavailable');
      const all = pages.data
        .flatMap((p) => p.check_runs)
        .sort((a, b) => b.id - a.id);
      if (!all.length) refuse('no check runs on the exact head');
      const unique = [
        ...new Map(
          all
            .toReversed()
            .map((c) => [`${c.app?.id ?? c.app_id}\0${c.name}`, c]),
        ).values(),
      ].sort((a, b) => b.id - a.id);
      const required = selector.source === 'pinned-app';
      const selected = required
        ? unique
            .filter(
              (c) =>
                c.name === selector.checkRunName &&
                c.app?.id === selector.appId &&
                (!c.head_sha || c.head_sha === head),
            )
            .slice(0, 1)
        : unique;
      const label = required
        ? `required check ${selector.checkRunName} (app ${selector.appId})`
        : '';
      if (!selected.length) refuse(`${label} is missing on the exact head`);
      for (const [i, c] of selected.entries())
        if (c.status !== 'completed' || c.conclusion !== 'success')
          refuse(
            `${required ? label : `check runs: ${selected.length}; failing run index ${i + 1}`} is not completed successfully (status ${c.status}, conclusion ${c.conclusion ?? 'missing'})`,
          );
      return {
        judges,
        checks: {
          count: selected.length,
          runs: selected.map((c, i) => ({
            index: i + 1,
            appId: c.app?.id ?? c.app_id ?? null,
            status: c.status,
            conclusion: c.conclusion,
          })),
        },
      };
    };
    const initial = evidence();
    const policyText = gitResult(['show', `${base}:krn.ship.json`]).out;
    if (Buffer.byteLength(policyText) > 65536)
      refuse('repository verifier policy unavailable or exceeds 64 KiB');
    const policy = z
      .object({ version: z.literal(1), verify: z.array(z.string()).min(1) })
      .strict()
      .safeParse(JSON.parse(policyText));
    if (
      !policy.success ||
      !/^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.mjs$/u.test(
        policy.data.verify[0] ?? '',
      )
    )
      refuse(
        'repository verifier policy must declare only version 1 and a non-empty verify argv starting with a safe repository-relative .mjs path',
      );
    const tempRoot = safeDirectory(root, ['.krn', 'tmp']);
    const worktree = fs.mkdtempSync(
      path.join(tempRoot, `krn-ship-pr-${options.pr}-`),
    );
    let tree: string;
    let merge: string;
    let repositoryEvidence: object;
    try {
      if (!gitResult(['worktree', 'add', '--detach', worktree, base]).ok)
        refuse('temporary worktree creation failed');
      let version: string;
      try {
        version = fs
          .readFileSync(path.join(worktree, '.node-version'), 'utf8')
          .trim();
      } catch {
        refuse('repository verifier pinned Node version is missing');
      }
      if (!/^\d+\.\d+\.\d+$/u.test(version))
        refuse('repository verifier pinned Node version is invalid');
      const node = (runtime.pinnedNode ?? pinnedNode)(version);
      if (!node)
        refuse(`repository verifier pinned Node ${version} is unavailable`);
      const result = run(
        node,
        [
          ...policy.data.verify,
          '--repo',
          root,
          '--base',
          base,
          '--head',
          head,
          '--pr',
          String(options.pr),
        ],
        { cwd: worktree, timeout: 180_000 },
      );
      const report = verifierSchema.safeParse(JSON.parse(result.out));
      if (!result.ok || !report.success)
        refuse('repository verifier did not pass');
      if (
        report.data.head !== head ||
        report.data.base !== base ||
        report.data.reviewRecords.some((r) => r.headSha !== head)
      )
        refuse(
          'repository verifier report head/base does not match the exact head and leased base',
        );
      repositoryEvidence = {
        policySha256: hash(policyText),
        verifier: policy.data.verify,
        stdoutSha256: hash(result.out),
        verdict: report.data.verdict,
        reasons: report.data.reasons,
        reviewRecords: report.data.reviewRecords,
        gateCheckRun: report.data.gateCheckRun,
      };
      if (
        !gitResult(
          ['merge', '--no-ff', '--no-edit', '-F', messagePath, head],
          worktree,
        ).ok
      )
        refuse('merge pre-check failed');
      merge = git(['rev-parse', '--verify', 'HEAD^{commit}'], worktree);
      tree = git(['rev-parse', 'HEAD^{tree}'], worktree);
    } finally {
      gitResult(['worktree', 'remove', '--force', worktree]);
      gitResult(['worktree', 'prune']);
      fs.rmSync(worktree, { recursive: true, force: true });
    }
    const record: Record<string, unknown> = {
      status: 'pending',
      repo: options.repo,
      pr: options.pr,
      base,
      githubBase: pr.baseRefOid,
      head,
      ...initial,
      cleanupFailures: [],
      precheck: { ok: true, errors: 0, warnings: 0, warningRules: [] },
      precheckedTree: tree,
      precheckedMerge: merge,
      dryRun: options.dryRun,
      startedAt,
      repositoryEvidence,
    };
    const recordPath = path.join(
      safeDirectory(root, ['.krn', 'runs', 'ship']),
      `pr-${options.pr}.json`,
    );
    if (fs.existsSync(recordPath)) {
      if (!fs.lstatSync(recordPath).isFile())
        refuse('delivery record unavailable; publication refused');
      let previous: unknown;
      try {
        previous = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      } catch {
        refuse('delivery record is malformed');
      }
      const saved = z
        .object({ status: z.string(), head: sha })
        .safeParse(previous);
      if (!saved.success) refuse('delivery record is malformed');
      if (saved.data.status === 'published' && saved.data.head !== head)
        refuse('final delivery record belongs to another head');
    }
    if (options.dryRun)
      return { ok: true as const, record: { ...record, completedAt: now() } };
    const current = readPr();
    if (current.state !== 'OPEN')
      refuse('PR is not open immediately before publication');
    if (current.headRefOid !== head)
      refuse('PR head changed immediately before publication');
    if (current.baseRefOid !== pr.baseRefOid || remoteBase() !== base)
      refuse(`${branch} advanced; re-run krn ship`);
    const publicationBranch = defaultBranch();
    if (publicationBranch !== branch)
      refuse(
        `default branch changed from ${branch} to ${publicationBranch} immediately before publication`,
      );
    if (current.baseRefName !== branch)
      refuse(
        `PR base is not ${branch} (received ${current.baseRefName}) immediately before publication`,
      );
    if (current.mergeable !== 'MERGEABLE')
      refuse('PR is not mergeable immediately before publication');
    const latest = evidence();
    Object.assign(record, latest, {
      evidence: { readAt: now(), ok: true, ...latest },
    });
    try {
      atomicRecord(recordPath, record);
    } catch {
      refuse('delivery record unavailable; publication refused');
    }
    const requestDir = fs.mkdtempSync(path.join(tempRoot, 'krn-ship-message-'));
    let response = '';
    try {
      const request = path.join(requestDir, 'request.json');
      fs.writeFileSync(
        request,
        JSON.stringify({
          merge_method: 'merge',
          sha: head,
          commit_title: parsedMessage.subject,
          commit_message: parsedMessage.body,
        }),
        { mode: 0o600 },
      );
      const leased = readPr();
      if (leased.headRefOid !== head)
        refuse('PR head changed immediately before publication');
      if (leased.baseRefOid !== pr.baseRefOid || remoteBase() !== base)
        refuse(`${branch} advanced; re-run krn ship`);
      if (leased.state !== 'OPEN')
        refuse('PR is not open immediately before publication');
      if (leased.mergeable !== 'MERGEABLE')
        refuse('PR is not mergeable immediately before publication');
      try {
        response = run(
          'gh',
          [
            'api',
            '--include',
            '--method',
            'PUT',
            '--input',
            request,
            `repos/${options.repo}/pulls/${options.pr}/merge`,
          ],
          { cwd: root },
        ).out;
      } catch {
        /* Read back an ambiguous PUT; never retry it. */
      }
    } finally {
      fs.rmSync(requestDir, { recursive: true, force: true });
    }
    const http =
      /^HTTP\/\S+\s+(\d{3})[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*)$/u.exec(
        response,
      );
    const httpStatus = http ? Number(http[1]) : null;
    const decode = (text: string): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };
    const body = z
      .object({
        merged: z.boolean().optional(),
        sha: sha.optional(),
        message: z.string().optional(),
      })
      .safeParse(decode(http?.[2] ?? ''));
    if (httpStatus !== null && httpStatus !== 200)
      refuse(
        `pull request merge API HTTP ${httpStatus}: ${body.success ? (body.data.message ?? 'GitHub response unavailable') : 'GitHub response unavailable'}`,
      );
    let published =
      httpStatus === 200 && body.success && body.data.merged
        ? body.data.sha
        : undefined;
    if (!published) {
      const readback = z
        .object({ merged: z.boolean(), merge_commit_sha: sha.nullable() })
        .safeParse(json(['api', `repos/${options.repo}/pulls/${options.pr}`]));
      if (readback.success && readback.data.merged)
        published = readback.data.merge_commit_sha ?? undefined;
    }
    if (!published)
      refuse(
        httpStatus === 200
          ? 'pull request merge API HTTP 200: merge result unavailable; PR is not merged'
          : 'pull request merge API transport failed; PR is not merged or readback unavailable',
      );
    git(['fetch', '--no-tags', 'origin', `refs/heads/${branch}`]);
    const observedMain = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    const contained = gitResult([
      'merge-base',
      '--is-ancestor',
      published,
      observedMain,
    ]).ok;
    const publishedTree = git(['rev-parse', '--verify', `${published}^{tree}`]);
    const parents = git(['show', '-s', '--format=%P', published]).split(' ');
    const parentsMatch =
      parents.length === 2 && parents[0] === base && parents[1] === head;
    const treeMatch = publishedTree === tree;
    if (!contained)
      refuse(
        `published merge not verified on ${branch}; investigate immediately`,
      );
    if (!parentsMatch || !treeMatch)
      refuse(
        `published merge diverged: ${!parentsMatch ? 'parents differ from leased base and head' : 'tree differs from pre-check'}; investigate immediately`,
      );
    const post = evidence();
    const readback = z
      .object({ state: z.string() })
      .safeParse(
        json([
          'pr',
          'view',
          String(options.pr),
          '--repo',
          options.repo,
          '--json',
          'state,mergeCommit',
        ]),
      );
    Object.assign(record, {
      status: 'published',
      merge: published,
      observedMain,
      publishedSha: published,
      mergeContained: contained,
      publishedTree,
      publishedParents: parents,
      treeMatch,
      publication: {
        method: 'pulls-merge-api',
        httpStatus,
        sha: published,
        status: 'merged',
      },
      prState: readback.success ? readback.data.state : null,
      postPublishEvidence: { readAt: now(), ok: true, ...post },
      completedAt: now(),
    });
    const cleanup = z
      .object({
        headRefName: z.string(),
        isCrossRepository: z.boolean(),
        headRepository: z
          .object({
            nameWithOwner: z.string().optional(),
            name: z.string().optional(),
            owner: z.object({ login: z.string() }).optional(),
          })
          .nullable(),
      })
      .safeParse(
        json([
          'pr',
          'view',
          String(options.pr),
          '--repo',
          options.repo,
          '--json',
          'headRefName,headRepository,isCrossRepository',
        ]),
      );
    let remote = 'skipped:PR metadata unavailable';
    if (cleanup.success) {
      const data = cleanup.data;
      const repository = data.headRepository;
      const slug =
        repository?.nameWithOwner ??
        `${repository?.owner?.login ?? ''}/${repository?.name ?? ''}`;
      remote = 'skipped:fork';
      if (
        !data.isCrossRepository &&
        slug.toLowerCase() === options.repo.toLowerCase() &&
        data.headRefName !== branch
      ) {
        const ref = `refs/heads/${data.headRefName}`;
        const read = gitResult(['ls-remote', '--refs', 'origin', ref]);
        const [id, name] = read.out.trim().split(/\s+/u);
        remote = !read.ok
          ? 'failed:origin ref read failed'
          : !name
            ? 'already-deleted'
            : id !== head
              ? 'skipped:origin ref changed'
              : gitResult([
                    'push',
                    `--force-with-lease=${ref}:${head}`,
                    'origin',
                    `:${ref}`,
                  ]).ok
                ? 'deleted'
                : 'failed:leased delete failed';
      }
    }
    record.branchCleanup = { remote, worktrees: [], localBranch: 'skipped' };
    try {
      atomicRecord(recordPath, record);
    } catch {
      refuse('published but delivery record update failed; investigate');
    }
    return { ok: true as const, record, recordPath };
  } catch (e) {
    if (e instanceof SyntaxError)
      return {
        ok: false as const,
        reason: 'repository verifier policy or report is invalid JSON',
      };
    if (e instanceof Refusal) return { ok: false as const, reason: e.message };
    throw e;
  }
}
export async function shipCommand(args: string[]) {
  const result = await ship(args);
  if (args.includes('--json'))
    process.stdout.write(
      `${JSON.stringify(result.ok ? { ...result.record, ...('recordPath' in result ? { recordPath: result.recordPath } : {}) } : result, null, 2)}\n`,
    );
  else if (result.ok)
    process.stdout.write(
      `${args.includes('--dry-run') ? 'dry-run passed' : 'merged'}${'recordPath' in result ? `; record: ${result.recordPath}` : ''}\n`,
    );
  else process.stderr.write(`ship refused: ${result.reason}\n`);
  if (!result.ok) process.exitCode = 1;
}
