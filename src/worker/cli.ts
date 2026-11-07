import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, matchesGlob, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { flagValue } from '../cli/flag-value.ts';
import { defaultCodexExecutable } from '../hosts/codex.ts';
import { reapAppServer } from '../hosts/codex-app-server.ts';
import {
  assertDriverIdentity,
  assertServerIdentity,
  executablePath,
  workerUnit,
} from './process.ts';
import { git, loadPolicy } from './scope.ts';
import { ensureSetup } from './setup-marker.ts';
import {
  acceptanceValueSchema,
  alive,
  atomic,
  effortSchema,
  failure,
  isMissing,
  lock,
  metricsSchema,
  modelSchema,
  pathSchema,
  readJson,
  readText,
  redact,
  reportSchema,
  requiresSchema,
  resultSchema,
  roundName,
  type Session,
  secureDir,
  sessionSchema,
  timeoutSchema,
  validateRun,
  WorkerError,
} from './state.ts';
import { workerTmp } from './trust.ts';

function reportLines(
  path: string,
  resultPath: string,
  round: string,
): string[] {
  let report: z.infer<typeof reportSchema>;
  try {
    report = readJson(path, reportSchema);
  } catch {
    return ['status: none'];
  }
  const clean = (text: string) =>
    redact(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ');
  const bounded = (text: string) => {
    const value = clean(text);
    if (Buffer.byteLength(value) <= 512) return value;
    const marker = `… (truncated; see rounds/${round}/report.json)`;
    let prefix = '';
    for (const character of value) {
      if (
        Buffer.byteLength(prefix + character) >
        512 - Buffer.byteLength(marker)
      )
        break;
      prefix += character;
    }
    return prefix + marker;
  };
  const blockers = report.blockers.filter((text) => clean(text).trim());
  const checks = report.checks.filter((check) => check.exit_code !== 0);
  const result = readJson(resultPath, resultSchema);
  return [
    `status: ${report.status}`,
    ...blockers.slice(0, 20).map((text) => `blocker: ${bounded(text)}`),
    ...(blockers.length > 20 ? [`… ${blockers.length - 20} more`] : []),
    ...checks
      .slice(0, 20)
      .map(
        (check) =>
          `failing check: ${bounded(check.cmd)} exit ${check.exit_code}`,
      ),
    ...(checks.length > 20 ? [`… ${checks.length - 20} more`] : []),
    ...result.acceptance
      .filter((entry) => entry.exit_code !== 0)
      .map(
        (entry) =>
          `acceptance: ${bounded(entry.cmd)} exit ${entry.exit_code ?? 'null'}`,
      ),
  ];
}

const optionNames =
  '--run --repo --brief --message --model --effort --allow --require --check --observer --timeout-min --compact'.split(
    ' ',
  );
const errorSchema = z.object({
  exit_code: z.number().int(),
  message: z.string(),
});
function inputText(path: string): string {
  const text = redact(readText(resolve(path)));
  if (Buffer.byteLength(text) > 256 * 1024)
    throw new WorkerError(65, 'redacted worker input exceeds 256 KB');
  return text;
}
export async function workerCommand(args: string[]): Promise<void> {
  let unlock: (() => void) | undefined;
  try {
    const [command, ...options] = args;
    if (!['start', 'send', 'stop'].includes(command ?? ''))
      throw new WorkerError(64, 'usage: worker start|send|stop --run DIR');
    const values = new Map<string, string>();
    const allows: string[] = [];
    const requires: string[] = [];
    const checks: string[] = [];
    const observers: string[] = [];
    for (let i = 0; i < options.length; i += 2) {
      const key = options[i];
      const value = flagValue(
        options,
        i,
        () => new WorkerError(64, 'invalid worker arguments'),
      );
      if (
        !key ||
        !optionNames.includes(key) ||
        (!['--allow', '--require', '--check', '--observer'].includes(key) &&
          values.has(key))
      )
        throw new WorkerError(64, 'invalid worker arguments');
      if (key === '--require') requires.push(value);
      else if (key === '--check') checks.push(value);
      else if (key === '--observer') observers.push(value);
      else if (key === '--allow') allows.push(value);
      else values.set(key, value);
    }
    const required = (key: string) => {
      const value = values.get(key);
      if (!value) throw new WorkerError(64, `missing ${key}`);
      return value;
    };
    for (const [key, value] of values) {
      const schema =
        key === '--model'
          ? modelSchema
          : key === '--effort'
            ? effortSchema
            : key === '--timeout-min'
              ? z.string().max(32)
              : key === '--compact'
                ? z.enum(['auto', 'always'])
                : pathSchema;
      if (!schema.safeParse(value).success)
        throw new WorkerError(64, `invalid ${key}`);
    }
    if (
      allows.length > 100 ||
      allows.some((value) => !pathSchema.safeParse(value).success)
    )
      throw new WorkerError(64, 'invalid --allow');
    if (
      !requiresSchema.safeParse(requires).success ||
      (requires.length && command !== 'start')
    )
      throw new WorkerError(
        64,
        'invalid --require: usage requires start and unique repository-relative file paths',
      );
    const entries = [...checks, ...observers];
    const invalidValue = entries.some(
      (value) => !acceptanceValueSchema.safeParse(value).success,
    );
    const invalidObserver = observers.some(
      (value) => value.startsWith('/') || value.split('/').includes('..'),
    );
    if (
      entries.length > 16 ||
      invalidValue ||
      invalidObserver ||
      (entries.length > 0 && command !== 'start')
    )
      throw new WorkerError(64, 'invalid acceptance options');
    // A value redact() would change is refused rather than stored altered:
    // the driver must run exactly what the lead declared, and a
    // credential-like value is never persisted.
    if (entries.some((value) => redact(value) !== value))
      throw new WorkerError(
        64,
        'invalid acceptance options: a --check or --observer value looks like a credential',
      );
    const timeoutMs = Number(values.get('--timeout-min') ?? 30) * 60000;
    if (!timeoutSchema.safeParse(timeoutMs).success)
      throw new WorkerError(64, 'invalid --timeout-min');
    if (values.has('--compact') && command !== 'send')
      throw new WorkerError(64, '--compact applies only to send');
    let run = resolve(required('--run'));
    const statePath = join(run, 'session.json');
    let repo: string;
    let text: string | undefined;
    let startCommit: string | undefined;
    let saved: Session | undefined;
    if (command === 'start') {
      repo = validateRun(resolve(required('--repo')), run);
      validateRun(repo, join(run, 'inbox'));
      validateRun(repo, join(run, 'tmp'));
      text = inputText(required('--brief'));
      startCommit = git(repo, 'rev-parse', 'HEAD').trim();
      const policy = loadPolicy(repo, startCommit);
      const forbidden = allows.find((value) =>
        policy.forbidden.some((glob) => matchesGlob(value, glob)),
      );
      if (forbidden)
        throw new WorkerError(
          64,
          `--allow ${forbidden} names a forbidden path`,
        );
      if (existsSync(join(repo, 'package.json'))) {
        const missingDependencies = `dependencies missing: run pnpm install --frozen-lockfile in ${repo}`;
        const installed = () => {
          try {
            return statSync(join(repo, 'node_modules/.bin')).isDirectory();
          } catch (error) {
            if (!isMissing(error) && !isMissing(error, 'ENOTDIR')) throw error;
            return false;
          }
        };
        // A fresh worktree has no dependencies: install them once (markers in .krn/setup), others wait.
        const ok = ensureSetup(repo, installed, () => {
          const install = spawnSync(
            process.env.KRN_PNPM_BIN ?? 'pnpm',
            ['install', '--frozen-lockfile'],
            {
              cwd: repo,
              encoding: 'utf8',
              stdio: ['ignore', 'ignore', 'pipe'],
            },
          );
          process.stderr.write(install.stderr ?? '');
          return {
            ok: install.status === 0,
            detail: `pnpm install exited ${install.status}\n${(install.stderr ?? '').slice(-4000)}`,
          };
        });
        if (!ok) throw new WorkerError(64, missingDependencies);
      }
    } else {
      if (command === 'stop' && !existsSync(run)) return;
      try {
        secureDir(run, false);
      } catch (error) {
        if (isMissing(error)) throw new WorkerError(65, 'worker run missing');
        throw error;
      }
      if (command === 'stop' && !existsSync(statePath)) return;
      saved = readJson(statePath, sessionSchema);
      try {
        repo = validateRun(saved.repo, run);
      } catch (error) {
        if (command === 'stop')
          throw new WorkerError(
            65,
            'worker session boundary identity mismatch',
          );
        throw error;
      }
      validateRun(repo, join(run, 'inbox'));
      if (saved.run !== run)
        throw new WorkerError(65, 'worker run identity mismatch');
      if (values.has('--repo') && resolve(required('--repo')) !== repo)
        throw new WorkerError(64, 'worker session boundary mismatch');
      if (command === 'send') text = inputText(required('--message'));
    }
    if (command === 'stop') {
      if (!saved) throw new WorkerError(65, 'worker state missing');
      const state = saved;
      assertServerIdentity(state, run, defaultCodexExecutable, true);
      if (assertDriverIdentity(state, run, true)) {
        try {
          process.kill(state.pid, 'SIGTERM');
        } catch (error) {
          if (!isMissing(error, 'ESRCH')) throw error;
        }
      }
      const deadline = Date.now() + 20000;
      while (alive(state.pid) && Date.now() < deadline) await delay(20);
      if (alive(state.pid))
        throw new WorkerError(75, 'worker stop did not finish');
      await reapAppServer(state, run, true);
      atomic(join(run, 'stop'), {});
      renameSync(statePath, join(run, 'closed-session.json'));
      rmSync(join(run, 'driver.lock'), { force: true });
      process.stdout.write('worker stopped\n');
      return;
    }
    secureDir(run);
    run = realpathSync(run);
    unlock = lock(join(run, 'client.lock'));
    let state: Session;
    if (command === 'start') {
      if (existsSync(statePath)) {
        const stale = readJson(statePath, sessionSchema);
        if (!alive(stale.pid)) await reapAppServer(stale, run, true);
        throw new WorkerError(75, 'worker session.json exists; run stop first');
      }
      for (const name of [
        'error.json',
        'rounds',
        'closed-session.json',
        'inbox',
        'stop',
        'summary.json',
        'driver.lock',
      ]) {
        try {
          lstatSync(join(run, name));
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        throw new WorkerError(
          75,
          `worker run contains ${name}; choose a fresh directory`,
        );
      }
      if (!startCommit || text === undefined)
        throw new WorkerError(70, 'missing prepared worker start');
      state = {
        repo,
        run,
        startCommit,
        model: redact(values.get('--model') ?? 'gpt-6-luna'),
        effort: effortSchema.parse(redact(values.get('--effort') ?? 'medium')),
        timeoutMs,
        allows,
        requires,
        checks,
        observers,
        roots: [repo, workerTmp(run)],
        threadId: '',
        pid: 0,
        pidStartTime: null,
        serverPid: 0,
        serverStartTime: null,
        serverGroup: 0,
        serverExecutable: executablePath(defaultCodexExecutable),
        unit: workerUnit(run),
        rounds: 0,
        status: 'running',
      };
      secureDir(join(run, 'tmp'));
      atomic(statePath, state);
      secureDir(join(run, 'inbox'));
      atomic(join(run, 'inbox/001.json'), {
        text: redact(text),
        model: redact(state.model),
        effort: redact(state.effort),
      });
      const child = spawn(
        process.execPath,
        [new URL('./driver.ts', import.meta.url).pathname, run],
        { cwd: repo, detached: true, stdio: 'ignore' },
      );
      await new Promise<void>((done, reject) => {
        child.once('spawn', done);
        child.once('error', reject);
      });
      child.unref();
      state.pid = child.pid ?? 0;
    } else {
      if (!saved) throw new WorkerError(65, 'worker state missing');
      state = saved;
      validateRun(state.repo, run);
      if (state.status !== 'running')
        throw new WorkerError(5, 'dead thread; start fresh with handoff');
      if (!alive(state.pid))
        throw new WorkerError(75, 'stale worker state; run stop first');
      if (!alive(state.serverPid))
        throw new WorkerError(75, 'worker server exited; run stop first');
      const previous = readJson(
        join(run, 'rounds', roundName(state.rounds), 'metrics.json'),
        metricsSchema,
      );
      if (state.rounds >= 3 || previous.cumulative.uncached_total > 1000000)
        throw new WorkerError(5, 'budget exhausted; start fresh with handoff');
      secureDir(join(run, 'inbox'));
      atomic(join(run, 'inbox', `${roundName(state.rounds + 1)}.json`), {
        text: redact(text ?? ''),
        model: redact(values.get('--model') ?? state.model),
        effort: redact(values.get('--effort') ?? state.effort),
        // Absent means auto (requestSchema default), so records stay unchanged.
        ...(values.has('--compact')
          ? { compact: values.get('--compact') }
          : {}),
      });
    }
    const resultPath = join(
      run,
      'rounds',
      roundName(state.rounds + 1),
      'result.json',
    );
    const deadline =
      Date.now() +
      state.timeoutMs +
      (state.checks.length + state.observers.length) * 600000 +
      25000;
    for (;;) {
      if (existsSync(resultPath)) {
        const result = readJson(resultPath, resultSchema);
        const line = `${result.message}${result.needs_lead_note.length ? `; needs_lead_note: ${result.needs_lead_note.join(', ')}` : ''}\n`;
        (result.exit_code ? process.stderr : process.stdout).write(
          `${redact(line)
            .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
            .trimEnd()}\n${reportLines(join(run, 'rounds', roundName(state.rounds + 1), 'report.json'), resultPath, roundName(state.rounds + 1)).join('\n')}\n`,
        );
        process.exitCode = result.exit_code;
        return;
      }
      if (existsSync(join(run, 'error.json'))) {
        const error = readJson(join(run, 'error.json'), errorSchema);
        throw new WorkerError(error.exit_code, error.message);
      }
      if (!alive(state.pid))
        throw new WorkerError(75, 'driver exited; run stop first');
      if (Date.now() >= deadline)
        throw new WorkerError(75, 'worker result deadline exceeded');
      await delay(20);
    }
  } catch (error) {
    const problem = failure(error);
    process.stderr.write(
      `${redact(problem.message).replace(/[\r\n]/g, ' ')}\n`,
    );
    process.exitCode = problem.exitCode;
  } finally {
    unlock?.();
  }
}
