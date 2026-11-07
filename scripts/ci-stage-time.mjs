// Per-stage delivery time of merged pull requests, from the real GitHub record.
//   node scripts/ci-stage-time.mjs collect <firstPr> <lastPr> > capture.json
//   node scripts/ci-stage-time.mjs report capture.json
// `collect` needs an authenticated `gh`; `report` is pure and reads a capture.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO = 'krn-works/krn';

/** @param {string | undefined} later @param {string | undefined} earlier */
const seconds = (later, earlier) =>
  later && earlier
    ? (Date.parse(later) - Date.parse(earlier)) / 1000
    : undefined;

/** @param {number[]} values @param {number} q */
export function percentile(values, q) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

/** Collapse `Test (3/8)` style names so shards aggregate into one row. */
const stageName = (/** @type {string} */ name) =>
  name.replace(/\(\d+\/\d+\)/u, '(shard)');

/**
 * @param {Array<any>} capture
 * @returns {{stages: Map<string, number[]>, counts: Record<string, number>}}
 */
export function analyze(capture) {
  /** @type {Map<string, number[]>} */
  const stages = new Map();
  const add = (
    /** @type {string} */ key,
    /** @type {number | undefined} */ value,
  ) => {
    if (value === undefined || Number.isNaN(value)) return;
    const list = stages.get(key) ?? [];
    list.push(Math.max(0, value));
    stages.set(key, list);
  };
  const counts = {
    prs: capture.length,
    pushes: 0,
    reruns: 0,
    rerunPrs: 0,
    failedJobs: 0,
  };
  for (const pr of capture) {
    const pushes = new Set(pr.runs.map((run) => run.head_sha));
    counts.pushes += Math.max(1, pushes.size);
    add('commit -> PR opened', seconds(pr.createdAt, pr.firstCommitAt));
    add('PR open -> merge (total)', seconds(pr.mergedAt, pr.createdAt));
    const final = pr.runs
      .filter((run) => run.head_sha === pr.headRefOid)
      .sort((a, b) => a.run_attempt - b.run_attempt)
      .at(-1);
    const attempts = pr.runs.reduce(
      (sum, run) => sum + Math.max(0, run.run_attempt - 1),
      0,
    );
    counts.reruns += attempts;
    if (attempts > 0) counts.rerunPrs += 1;
    for (const run of pr.runs)
      for (const job of run.jobs ?? [])
        if (job.conclusion === 'failure') counts.failedJobs += 1;
    if (!final) continue;
    const jobs = final.jobs.filter((job) => job.completed_at);
    const starts = jobs.map((job) => Date.parse(job.started_at));
    const ends = jobs.map((job) => Date.parse(job.completed_at));
    add(
      'PR open -> first CI job started',
      seconds(new Date(Math.min(...starts)).toISOString(), pr.createdAt),
    );
    add(
      'CI wall (first start -> Check done)',
      (Math.max(...ends) - Math.min(...starts)) / 1000,
    );
    const check = jobs.find((job) => job.name === 'Check');
    add('Check done -> merge', seconds(pr.mergedAt, check?.completed_at));
    for (const job of jobs) {
      const name = stageName(job.name);
      add(`job queue: ${name}`, seconds(job.started_at, job.created_at));
      add(`job run: ${name}`, seconds(job.completed_at, job.started_at));
      for (const step of job.steps ?? [])
        if (
          step.started_at &&
          step.completed_at &&
          !/^(Set up job|Complete job|Post )/u.test(step.name)
        )
          add(
            `  step: ${name} / ${step.name}`,
            seconds(step.completed_at, step.started_at),
          );
    }
  }
  return { stages, counts };
}

/** @param {ReturnType<typeof analyze>} analysis */
export function renderReport({ stages, counts }) {
  const rows = [...stages.entries()]
    .map(([stage, values]) => ({
      stage,
      n: values.length,
      median: percentile(values, 0.5) ?? 0,
      p90: percentile(values, 0.9) ?? 0,
    }))
    .sort((a, b) => a.stage.localeCompare(b.stage));
  const lines = [
    `PRs: ${counts.prs}; pushes: ${counts.pushes} (${(counts.pushes / counts.prs).toFixed(2)} per PR); ` +
      `reruns: ${counts.reruns} across ${counts.rerunPrs} PRs; failed jobs: ${counts.failedJobs}`,
    '',
    '| stage | n | median s | p90 s |',
    '| --- | ---: | ---: | ---: |',
    ...rows.map(
      (r) =>
        `| ${r.stage} | ${r.n} | ${r.median.toFixed(0)} | ${r.p90.toFixed(0)} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

/** @param {string[]} args */
const gh = (args) =>
  JSON.parse(
    execFileSync('gh', ['api', '--paginate', '--slurp', ...args], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    }),
  );
const flat = (/** @type {any[]} */ pages, /** @type {string} */ key) =>
  pages.flatMap((page) => (key ? page[key] : page));

/** @param {number} first @param {number} last */
export function collect(first, last) {
  const prs = JSON.parse(
    execFileSync(
      'gh',
      [
        'pr',
        'list',
        '-R',
        REPO,
        '--state',
        'merged',
        '--limit',
        '200',
        '--json',
        'number,headRefName,headRefOid,createdAt,mergedAt',
      ],
      { encoding: 'utf8', maxBuffer: 1 << 28 },
    ),
  ).filter((/** @type {any} */ pr) => pr.number >= first && pr.number <= last);
  return prs.map((/** @type {any} */ pr) => {
    const runs = flat(
      gh([
        `repos/${REPO}/actions/runs?branch=${pr.headRefName}&event=pull_request&per_page=100`,
      ]),
      'workflow_runs',
    );
    return {
      number: pr.number,
      headRefOid: pr.headRefOid,
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt,
      firstCommitAt: flat(
        gh([`repos/${REPO}/pulls/${pr.number}/commits?per_page=100`]),
        '',
      )
        .map((/** @type {any} */ c) => c.commit.author.date)
        .sort()[0],
      runs: runs.map((/** @type {any} */ run) => {
        const jobs = [];
        for (let attempt = 1; attempt <= run.run_attempt; attempt += 1)
          for (const job of flat(
            gh([
              `repos/${REPO}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`,
            ]),
            'jobs',
          ))
            jobs.push({
              ...job,
              attempt,
              steps: job.steps?.map((/** @type {any} */ s) => ({
                name: s.name,
                started_at: s.started_at,
                completed_at: s.completed_at,
              })),
            });
        const last = jobs
          .filter((job) => job.attempt === run.run_attempt)
          .map(({ attempt, ...job }) => job);
        const earlier = jobs
          .filter((job) => job.attempt < run.run_attempt)
          .map(({ attempt, ...job }) => ({
            name: job.name,
            conclusion: job.conclusion,
          }));
        return {
          id: run.id,
          head_sha: run.head_sha,
          run_attempt: run.run_attempt,
          jobs: [
            ...last,
            ...earlier.filter((job) => job.conclusion === 'failure'),
          ],
        };
      }),
    };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'collect' && a && b)
    process.stdout.write(`${JSON.stringify(collect(Number(a), Number(b)))}\n`);
  else if (mode === 'report' && a)
    process.stdout.write(
      renderReport(analyze(JSON.parse(readFileSync(a, 'utf8')))),
    );
  else {
    process.stderr.write(
      'usage: ci-stage-time.mjs collect <firstPr> <lastPr> | report <capture.json>\n',
    );
    process.exit(64);
  }
}
