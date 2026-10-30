import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { github, type Runner, run } from '../deliver/transport.ts';
import { credentialShapeKind } from '../foreman/credential-shape.ts';

export interface TriageOptions {
  head?: string;
  base?: string;
  log?: string;
  baseLog?: string;
  ciRun?: string;
  repo?: string;
  out?: string;
  logText?: string;
  baseText?: string;
}
export interface TriageRuntime {
  cwd?: string;
  run?: Runner;
}
export type FailureClass =
  | 'runner-lost'
  | 'sandbox-tooling'
  | 'policy'
  | 'timeout'
  | 'test-failure'
  | 'unknown';
interface FailedTest {
  name: string;
  location: string;
  file: string;
  adr?: string;
}

/** Bounds that keep every persisted artifact small whatever the log holds. */
const limits = { tests: 50, field: 500, excerptLines: 200, versionLines: 10 };
const repoLimits = { owner: 39, name: 100, ciRun: 20 };
/** Search at most ten attempts, newest first. */
const maxAttempts = 10;
const clip = (value: string) =>
  value.length > limits.field
    ? `${value.slice(0, limits.field)} [truncated ${value.length - limits.field} chars]`
    : value;

/** Reuse the repository credential detector; suppress whole sensitive lines. */
export function redact(text: string): string {
  return text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[^\n]*(?:\n[A-Za-z0-9+/=]+[\t \r]*)*(?:\n-----END [A-Z ]*PRIVATE KEY-----)?/gu,
      '[redacted]',
    )
    .replace(
      /\b([\w.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[\w.-]*)(["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu,
      '$1$2[redacted]',
    )
    .split('\n')
    .map((line) =>
      credentialShapeKind(line)
        ? '[redacted]'
        : line.replace(
            /\bgh[pousr]_[A-Za-z0-9_]+|\bBearer\s+[^\s"'<>]+/giu,
            '[redacted]',
          ),
    )
    .join('\n');
}
export function classify(log: string): FailureClass {
  if (
    /The self-hosted runner lost communication with the server|runner[^\n]*(?:shut(?:ting)?\s*down|shutdown|cancel)|(?:shutdown|cancel)[^\n]*runner/iu.test(
      log,
    )
  )
    return 'runner-lost';
  if (
    (/Cannot find module/u.test(log) && /npm-cli\.js/u.test(log)) ||
    /npm: command not found|(?:spawn[^\n]*npm[^\n]*ENOENT|ENOENT[^\n]*npm)/u.test(
      log,
    )
  )
    return 'sandbox-tooling';
  if (
    failures(log, '').some((test) =>
      /(?:^|\/)test\/rules\//u.test(test.location),
    )
  )
    return 'policy';
  if (/timed out|testTimeoutFailure|ETIMEDOUT/iu.test(log)) return 'timeout';
  if (/not ok \d+ - |✖/u.test(log)) return 'test-failure';
  return 'unknown';
}
export function decision(file: string): string {
  try {
    return (
      readFileSync(file, 'utf8').match(/^\/\/ Decision: ([^\r\n]+)$/mu)?.[1] ??
      'unrecorded'
    );
  } catch {
    return 'unrecorded';
  }
}
function testNames(log: string, passing: boolean): string[] {
  const pattern = passing
    ? /(?:^|\s)ok \d+ - ([^\r\n]+)|✔\s+([^\r\n]+)/gmu
    : /(?:not ok \d+ - |✖\s+)([^\r\n]+)/gmu;
  return [
    ...new Set(
      [...log.matchAll(pattern)]
        .map((m) =>
          (m[1] ?? m[2] ?? '').replace(/\s+\([\d.]+m?s\)$/u, '').trim(),
        )
        .filter((name) => name && name !== 'failing tests:'),
    ),
  ];
}
function failures(log: string, cwd: string): FailedTest[] {
  return testNames(log, false).map((name) => {
    // TAP locations follow their failure; the spec reporter prints them before it.
    const marker = [
      ...log.matchAll(/(?:not ok \d+ - |✖\s+)([^\r\n]+)/gmu),
    ].findLast((m) => m[1]?.replace(/\s+\([\d.]+m?s\)$/u, '').trim() === name);
    const offset = marker?.index ?? 0;
    const tail =
      log.slice(offset).split(/\n(?=\s*(?:not ok \d+ - |# Subtest:|✖))/u)[0] ??
      '';
    const previous = log
      .slice(0, offset)
      .match(/test at ([^\r\n]+)\n[^\r\n]*$/u)?.[1];
    const reported =
      tail.match(/location:\s*['"]?([^'"\r\n]+)/u)?.[1]?.trim() ??
      previous ??
      tail.match(/(?:file:\/\/)?((?:\/|test\/)[^\s()]+:\d+:\d+)/u)?.[1] ??
      'unrecorded';
    // Wrappers such as scripts/isolation-gate.mjs report their own line; the
    // stack frame inside the test file is the one a worker can rerun.
    const frame = tail.match(
      /(?:file:\/\/)?((?:\/[^\s()]*)?test\/[^\s()]+\.test\.[cm]?[jt]s:\d+:\d+)/u,
    )?.[1];
    const location = /\.test\.[cm]?[jt]s:\d+/u.test(reported)
      ? reported
      : (frame ?? reported);
    let file = location
      .replace(/^file:\/\//u, '')
      .replace(/:\d+(?::\d+)?$/u, '');
    // Scratch and CI runner checkouts retain their roots. Resolve test files
    // against the worker checkout.
    const relative = file.match(/^(?:.*\/)?(test\/[^/].*)$/u)?.[1];
    if (relative && isAbsolute(file)) file = join(cwd, relative);
    return {
      name,
      location,
      file,
    };
  });
}
/** GitHub's --log-failed prefixes every job line with a step and timestamp. */
function normalizeLog(log: string): string {
  return log
    .replace(/^\uFEFF/u, '')
    .replace(
      /^[^\t\r\n]+\t[^\t\r\n]+\t\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /gmu,
      '',
    );
}
const runSchema = z.object({
  headSha: z.string().regex(/^[a-f\d]{40}$/iu),
  attempt: z.number().int().positive().optional().default(1),
});
const jobsSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.number().int().positive(),
      conclusion: z.string().nullable(),
      steps: z.array(
        z.object({
          status: z.string().optional(),
          started_at: z.string().nullable().optional(),
        }),
      ),
    }),
  ),
});
const annotationsSchema = z.array(
  z.object({
    message: z.string(),
    title: z.string().optional(),
    path: z.string().optional(),
    start_line: z.number().optional(),
  }),
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function excerpt(log: string): string {
  const lines = log.split(/\r?\n/u);
  const selected = new Set<number>();
  for (let i = 0; i < lines.length; i++)
    if (
      /not ok \d+ - |✖|test at |lost communication|ENOENT|timed out|Cannot find module/u.test(
        lines[i] ?? '',
      )
    ) {
      for (
        let j = Math.max(0, i - 1);
        j < Math.min(lines.length, i + 25);
        j++
      ) {
        if (selected.size >= limits.excerptLines) break;
        selected.add(j);
      }
    }
  for (let i = 0; i < lines.length && selected.size < limits.excerptLines; i++)
    selected.add(i);
  return [...selected].map((i) => clip(lines[i] ?? '')).join('\n');
}
export async function triage(
  options: TriageOptions,
  runtime: TriageRuntime = {},
) {
  const cwd = resolve(runtime.cwd ?? process.cwd());
  const runner = runtime.run ?? run;
  if (options.repo || options.ciRun) {
    const [owner, name] = (options.repo ?? '').split('/');
    if (
      !options.repo ||
      !options.ciRun ||
      !owner ||
      !name ||
      owner.length > repoLimits.owner ||
      name.length > repoLimits.name ||
      !/^\d+$/u.test(options.ciRun) ||
      options.ciRun.length > repoLimits.ciRun
    )
      throw new Error('Invalid triage arguments');
  }
  const missing: { item: string; command: string }[] = [];
  const need = (item: string, command: string) =>
    missing.push({ item, command });
  let head = options.head ?? '';
  const base = options.base ?? '';
  let log = options.logText ?? '';
  let annotations = '';
  let attempt: number | undefined;
  const read = (path: string, item: string) => {
    try {
      return redact(readFileSync(resolve(cwd, path), 'utf8'));
    } catch {
      need(
        item,
        `krn triage --${item} ${quote(path)} # provide a readable file`,
      );
      return '';
    }
  };
  if (options.log) log = read(options.log, 'log');
  if (options.ciRun && options.repo) {
    const gh = (args: string[]) => github(args, cwd, runner);
    try {
      const info = runSchema.parse(
        JSON.parse(
          await gh([
            'run',
            'view',
            options.ciRun,
            '--repo',
            options.repo,
            '--json',
            'headSha,attempt',
          ]),
        ),
      );
      if (head && head !== info.headSha)
        throw new Error('head differs from CI run');
      head = info.headSha;
      let jobs: z.infer<typeof jobsSchema> = { jobs: [] };
      for (
        let n = info.attempt;
        n > Math.max(0, info.attempt - maxAttempts);
        n--
      ) {
        const candidate = jobsSchema.parse(
          JSON.parse(
            await gh([
              'api',
              `repos/${options.repo}/actions/runs/${options.ciRun}/attempts/${n}/jobs`,
            ]),
          ),
        );
        if (
          candidate.jobs.some((job) =>
            ['failure', 'cancelled', 'timed_out'].includes(
              job.conclusion ?? '',
            ),
          )
        ) {
          attempt = n;
          jobs = candidate;
          break;
        }
      }
      if (attempt === undefined)
        need(
          `failed CI attempt: none found in latest ${Math.min(info.attempt, maxAttempts)} attempts`,
          `gh run view ${options.ciRun} --repo ${options.repo} --json headSha,attempt`,
        );
      for (const job of jobs.jobs) {
        const entries = annotationsSchema.parse(
          JSON.parse(
            await gh([
              'api',
              `repos/${options.repo}/check-runs/${job.id}/annotations`,
            ]),
          ),
        );
        annotations += `\n${entries.map((a) => `${a.path ?? ''}:${a.start_line ?? ''} ${a.title ?? ''} ${a.message}`).join('\n')}`;
        if (
          ['failure', 'cancelled', 'timed_out'].includes(
            job.conclusion ?? '',
          ) &&
          !job.steps.some((s) => s.status !== 'queued' && Boolean(s.started_at))
        )
          annotations += '\nrunner shutdown: job with no step run';
      }
      if (attempt !== undefined) {
        try {
          log = redact(
            await gh([
              'run',
              'view',
              options.ciRun,
              '--repo',
              options.repo,
              '--attempt',
              String(attempt),
              '--log-failed',
            ]),
          );
        } catch {
          // The recovery entry is added below after checking annotations.
        }
        if (
          !log.trim() &&
          !['runner-lost', 'sandbox-tooling'].includes(classify(annotations))
        )
          need(
            'log',
            `gh run view ${options.ciRun} --repo ${options.repo} --attempt ${attempt} --log-failed`,
          );
      }
    } catch {
      need(
        'CI metadata',
        `gh run view ${options.ciRun} --repo ${options.repo} --json headSha,attempt`,
      );
    }
  }
  log = redact(normalizeLog(`${log}${annotations}`));
  if (!head) need('head', 'git rev-parse HEAD # pass as --head');
  if (!base) need('base', 'git merge-base HEAD origin/main # pass as --base');
  if (!log.trim() && !(options.ciRun && options.repo))
    need(
      'log',
      'node --test <test-file> > head.log 2>&1 # pass --log head.log',
    );
  const kind = classify(log);
  const failed = failures(log, cwd);
  const truncated: string[] = [];
  if (failed.length > limits.tests)
    truncated.push(`failing tests: kept ${limits.tests} of ${failed.length}`);
  // Full names and paths stay for matching and commands; artifacts get clipped copies.
  const kept = failed.slice(0, limits.tests);
  const pattern = (name: string) =>
    quote(name.slice(0, limits.field).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const tests: FailedTest[] = kept.map((test) => ({
    name: clip(test.name),
    location: clip(test.location),
    file: clip(test.file),
    ...(/(?:^|\/)test\/rules\//u.test(test.file)
      ? { adr: clip(decision(test.file)) }
      : {}),
  }));
  for (const test of tests)
    if (test.adr === 'unrecorded')
      need(
        `ADR id: ${test.name}`,
        `add a "// Decision: <ADR or rule id>" header to ${test.file}`,
      );
  let verdict: 'confirmed' | 'failed-at-base' | 'insufficient' = 'confirmed';
  const environment = kind === 'runner-lost' || kind === 'sandbox-tooling';
  if (kind === 'unknown')
    need(
      'class',
      'node --test <failing-test-file> > head.log 2>&1 # pass --log head.log',
    );
  else if (!environment) {
    if (!tests.length)
      need(
        'failing test names',
        'node --test --test-reporter=tap <failing-test-file> > head.log 2>&1',
      );
    let baseText = options.baseText;
    if (options.baseLog) baseText = read(options.baseLog, 'base-log');
    if (!baseText?.trim())
      need(
        'base-log',
        'git -C <base-checkout> rev-parse HEAD; node --test <test-file> > base.log 2>&1 # at base; pass --base-log base.log',
      );
    else {
      const baseFailed = testNames(baseText, false);
      const passed = testNames(baseText, true);
      if (
        failed.length &&
        failed.every((test) => baseFailed.includes(test.name))
      )
        verdict = 'failed-at-base';
      else {
        const absent = failed.filter(
          (test) =>
            !baseFailed.includes(test.name) && !passed.includes(test.name),
        );
        for (const test of absent.slice(0, limits.tests))
          need(
            `base evidence: ${clip(test.name)}`,
            `node --test --test-name-pattern ${pattern(test.name)} ${quote(clip(test.file))} > base.log 2>&1 # at base; pass --base-log base.log`,
          );
        if (absent.length > limits.tests)
          truncated.push(
            `base evidence: kept ${limits.tests} of ${absent.length} missing entries`,
          );
      }
    }
  }
  if (missing.length) verdict = 'insufficient';
  const versions: Record<string, string> = {};
  try {
    versions['.node-version'] = clip(
      redact(readFileSync(join(cwd, '.node-version'), 'utf8').trim()),
    );
  } catch {
    versions['.node-version'] = 'unavailable';
  }
  for (const tool of ['node', 'npm', 'git']) {
    const result = runner(tool, ['--version'], cwd);
    versions[tool] = clip(
      redact(result.code === 0 ? result.stdout.trim() : 'unavailable'),
    );
  }
  const logged = log
    .split('\n')
    .filter((line) => /\bnode v\d|\bnpm (?:v?\d|version)/iu.test(line));
  if (logged.length > limits.versionLines)
    truncated.push(
      `log version lines: kept ${limits.versionLines} of ${logged.length}`,
    );
  versions.log =
    logged.slice(0, limits.versionLines).map(clip).join('\n') || 'unrecorded';
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
  const out = resolve(
    cwd,
    options.out ??
      `.krn/runs/triage/${head.slice(0, 12) || 'unknown'}-${stamp}`,
  );
  if (redact(out) !== out || /[\r\n]/u.test(out))
    throw new Error('Unsafe output path');
  const brief = join(out, 'brief.md');
  const commands = kept.map((test) =>
    test.file === 'unrecorded'
      ? 'unavailable: test file location missing'
      : test.file.length > limits.field
        ? `unavailable: test file path exceeds ${limits.field} chars`
        : `node --test --test-name-pattern ${pattern(test.name)} ${quote(isAbsolute(test.file) ? test.file : resolve(cwd, test.file))}`,
  );
  for (const test of tests)
    if (!environment && test.file === 'unrecorded') {
      need(
        `test location: ${test.name}`,
        'node --test --test-reporter=tap <test-file> > head.log 2>&1',
      );
      verdict = 'insufficient';
    }
  const result = {
    verdict,
    class: kind,
    head,
    base,
    attempt,
    tests,
    versions,
    missing,
    commands,
    excerpt: excerpt(log),
    truncated,
    brief,
    exitCode: verdict === 'insufficient' ? 66 : 0,
  };
  const text = `# Worker brief\n\nVerdict: ${verdict}\nClass: ${kind}\nHead: ${head || 'missing'}\nBase: ${base || 'missing'}\n${attempt === undefined ? '' : `Attempt: ${attempt}\n`}\n${environment ? 'Environment signature confirmed; not head-attributable.' : 'Base evidence compares the same failing test names.'}\n\n## Feedback loop\n\nRun one red, deterministic, fast command at the indicated revision before editing:\n${commands.map((command) => `- ${command}`).join('\n') || '- unavailable: environment recovery or missing evidence required'}\n\n## Failing tests\n\n${tests.map((test) => `- ${test.name} — ${test.location}${test.adr ? `; ADR: ${test.adr}` : ''}`).join('\n') || '- none recorded'}\n\n## Missing evidence\n\n${missing.map((m) => `- ${m.item}: ${m.command}`).join('\n') || '- none'}\n\n## Truncated\n\n${truncated.map((t) => `- ${t}`).join('\n') || '- none'}\n\n## Tool versions\n\n${Object.entries(
    versions,
  )
    .map(([tool, version]) => `${tool}: ${version}`)
    .join(
      '\n',
    )}\n\n## Log excerpt (at most 200 lines, failing blocks first)\n\n\`\`\`text\n${result.excerpt}\n\`\`\`\n`;
  mkdirSync(out, { recursive: true });
  writeFileSync(brief, redact(text));
  writeFileSync(
    join(out, 'triage.json'),
    `${JSON.stringify(result, (_key, value: unknown) => (typeof value === 'string' ? redact(value) : value), 2)}\n`,
  );
  return result;
}
