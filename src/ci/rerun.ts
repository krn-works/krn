// A lead re-attempts an infrastructure krn/gate failure on the same PR head through
// the trusted Jenkins job, as the lead account, without operator login.
import { spawnSync } from 'node:child_process';

export class RerunError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

export type GhRunner = (args: readonly string[]) => {
  readonly code: number;
  readonly stdout: string;
};
export type RerunDependencies = {
  readonly gh?: GhRunner;
  readonly fetcher?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
};
export type RerunInput = {
  readonly pr: number;
  readonly head: string;
  readonly repo?: string;
};

const responseLimit = 1024 * 1024;
const defaultJenkinsUrl = 'http://127.0.0.1:18080';
const pending = new Set([
  'queued',
  'in_progress',
  'requested',
  'waiting',
  'pending',
]);

const runGh: GhRunner = (args) => {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: responseLimit,
    timeout: 30_000,
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '' };
};

function parseJson(text: string, field: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RerunError(`${field} is not valid JSON`, 65);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readJson(response: Response, field: string): Promise<unknown> {
  // Stop reading at the bound instead of buffering an unbounded body first.
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader === undefined) throw new RerunError(`${field} is empty`, 65);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > responseLimit) {
        await reader.cancel();
        throw new RerunError(`${field} exceeds 1 MiB`, 65);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RerunError) throw error;
    throw new RerunError(`${field} could not be read`, 75);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'), field);
}

/** The PR head of the job's last build, from its native SCMRevisionAction only. */
export function jenkinsPullHash(job: unknown): string | undefined {
  const actions = record(record(job)?.lastBuild)?.actions;
  if (!Array.isArray(actions)) return undefined;
  const hashes = actions
    .map(record)
    .filter((action) => action?._class === 'jenkins.scm.api.SCMRevisionAction')
    .map((action) => record(action?.revision)?.pullHash);
  const [hash] = hashes;
  return hashes.length === 1 &&
    typeof hash === 'string' &&
    /^[0-9a-f]{40}$/u.test(hash)
    ? hash
    : undefined;
}

export async function rerun(
  input: RerunInput,
  dependencies: RerunDependencies = {},
): Promise<string> {
  if (!Number.isInteger(input.pr) || input.pr < 1 || input.pr > 10_000_000)
    throw new RerunError(
      '--pr must be a positive integer at most 10000000',
      64,
    );
  if (!/^[0-9a-f]{40}$/u.test(input.head))
    throw new RerunError('--head must be a full 40-hex lowercase SHA', 64);
  if (input.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/u.test(input.repo))
    throw new RerunError('--repo must be <owner>/<repo>', 64);
  const env = dependencies.env ?? process.env;
  const user = env.KRN_JENKINS_USER;
  const token = env.KRN_JENKINS_TOKEN;
  if (!user || !token)
    throw new RerunError('Set KRN_JENKINS_USER and KRN_JENKINS_TOKEN', 64);
  const jenkinsUrl = (env.KRN_JENKINS_URL || defaultJenkinsUrl).replace(
    /\/+$/u,
    '',
  );
  if (!/^https?:\/\/[^/\s]+$/u.test(jenkinsUrl))
    throw new RerunError('KRN_JENKINS_URL must be an http(s) origin', 64);

  const runner = dependencies.gh ?? runGh;
  const gh = (args: readonly string[], field: string) => {
    const result = runner(args);
    if (result.code !== 0)
      throw new RerunError(`GitHub query failed: ${field}`, 75);
    return parseJson(result.stdout, field);
  };
  const repo =
    input.repo ??
    record(gh(['repo', 'view', '--json', 'nameWithOwner'], 'repo view'))
      ?.nameWithOwner;
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/u.test(repo))
    throw new RerunError('nameWithOwner missing', 65);
  const pull = record(
    gh(['api', `repos/${repo}/pulls/${input.pr}`], 'pull request'),
  );
  const head = record(pull?.head)?.sha;
  if (typeof head !== 'string')
    throw new RerunError('pull request head.sha missing', 65);
  if (head !== input.head)
    throw new RerunError(`Pull request head ${head} does not match --head`, 65);
  const page = record(
    gh(
      [
        'api',
        `repos/${repo}/commits/${input.head}/check-runs?check_name=krn/gate&per_page=100`,
      ],
      'check runs',
    ),
  );
  const runs = page?.check_runs;
  if (!Array.isArray(runs)) throw new RerunError('check_runs missing', 65);
  // One page must hold every run, or a newer pending run could hide on the next page.
  if (typeof page?.total_count !== 'number' || page.total_count !== runs.length)
    throw new RerunError(
      `krn/gate check runs are incomplete (${String(page?.total_count)} total, ${runs.length} read)`,
      65,
    );
  let latest: Record<string, unknown> | undefined;
  for (const value of runs) {
    const run = record(value);
    if (run?.name !== 'krn/gate') continue;
    if (typeof run.id !== 'number' || typeof run.status !== 'string')
      throw new RerunError('check run id or status missing', 65);
    if (latest === undefined || run.id > (latest.id as number)) latest = run;
  }
  if (latest !== undefined && pending.has(latest.status as string))
    throw new RerunError(
      `krn/gate check run ${latest.id} is still ${latest.status}`,
      75,
    );

  const job = `/job/ci/job/product/job/PR-${input.pr}`;
  const authorization = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
  const fetcher = dependencies.fetcher ?? fetch;
  const request = async (path: string, init: RequestInit) => {
    try {
      return await fetcher(`${jenkinsUrl}${path}`, {
        ...init,
        headers: { authorization },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new RerunError(
        `Jenkins request failed for ${path.split('?')[0]}`,
        75,
      );
    }
  };
  const metadataPath = `${job}/api/json?tree=lastBuild[number,actions[_class,revision[_class,pullHash]]]`;
  const metadata = await request(metadataPath, { method: 'GET' });
  if (metadata.status !== 200)
    throw new RerunError(
      `Jenkins returned status ${metadata.status} for ${job}/api/json`,
      75,
    );
  const built = jenkinsPullHash(await readJson(metadata, 'Jenkins job'));
  if (built !== input.head)
    throw new RerunError(
      `Jenkins has not indexed this head (last build ${built ?? 'unknown'}); push or scan first`,
      65,
    );
  const queued = await request(`${job}/build`, { method: 'POST' });
  if (queued.status !== 201)
    throw new RerunError(
      `Jenkins returned status ${queued.status} for ${job}/build`,
      75,
    );
  // Print only the queue item number: the Location value is never echoed.
  const item = /\/queue\/item\/(\d{1,12})\/?$/u.exec(
    queued.headers.get('location') ?? '',
  )?.[1];
  if (item === undefined)
    throw new RerunError('Jenkins queue location is missing or malformed', 65);
  return `RERUN queued pr=${input.pr} head=${input.head} queue-item=${item}`;
}
