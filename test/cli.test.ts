import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordRepo } from '../src/foreman/state.ts';

const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

test('krn review maps invalid argument values to exit code 64', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-review-invalid-'));
  try {
    const lens = join(directory, 'lens.md');
    await writeFile(lens, 'Review the change.\n');
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'review',
        '--repo',
        directory,
        '--base',
        'b'.repeat(40),
        '--head',
        'c'.repeat(40),
        '--lens',
        lens,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 64, result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('krn review maps an invalid base revision to exit code 64', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-review-base-'));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', directory, ...args], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '--quiet');
    git('config', 'user.name', 'KRN CLI test');
    git('config', 'user.email', 'krn-test@example.invalid');
    await writeFile(join(directory, 'README.md'), 'review fixture\n');
    await writeFile(join(directory, 'lens.md'), 'Review the change.\n');
    git('add', 'README.md', 'lens.md');
    git('commit', '-qm', 'create review fixture');
    const head = git('rev-parse', 'HEAD');
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'review',
        '--repo',
        directory,
        '--base',
        'missing-review-base',
        '--head',
        head,
        '--lens',
        join(directory, 'lens.md'),
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 64, result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('krn review maps a runtime failure to exit code 70', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-review-runtime-'));
  const outside = await mkdtemp(join(tmpdir(), 'krn-review-runtime-state-'));
  try {
    const lens = join(directory, 'lens.md');
    await writeFile(lens, 'Review the change.\n');
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', directory, ...args], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '--quiet');
    git('config', 'user.name', 'KRN CLI test');
    git('config', 'user.email', 'krn-test@example.invalid');
    await writeFile(join(directory, 'README.md'), 'runtime fixture\n');
    git('add', 'README.md', 'lens.md');
    git('commit', '-qm', 'create review fixture');
    const head = git('rev-parse', 'HEAD');
    await symlink(outside, join(directory, '.krn'));
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'review',
        '--repo',
        directory,
        '--base',
        head,
        '--head',
        head,
        '--lens',
        lens,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 70, result.stderr);
    assert.match(result.stderr, /unsafe repository state directory/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('review verdict and error exit codes are stable', async () => {
  const mainSource = readFileSync(
    new URL('../src/cli/main.ts', import.meta.url),
    'utf8',
  );
  const flowSource = readFileSync(
    new URL('../src/flow/cli.ts', import.meta.url),
    'utf8',
  );
  assert.match(mainSource, /export function reviewOutcomeExitCode/u);
  assert.match(flowSource, /export class ReviewUsageError/u);
  const [{ reviewErrorExitCode, reviewOutcomeExitCode }, { ReviewUsageError }] =
    await Promise.all([
      import('../src/cli/main.ts'),
      import('../src/flow/cli.ts'),
    ]);

  assert.equal(reviewOutcomeExitCode('PASS'), 0);
  assert.equal(reviewOutcomeExitCode('FAIL'), 1);
  assert.equal(reviewOutcomeExitCode('INCOMPLETE'), 2);
  assert.equal(reviewOutcomeExitCode('OVERRIDE'), 0);
  assert.equal(reviewErrorExitCode(new ReviewUsageError('bad arguments')), 64);
  assert.equal(reviewErrorExitCode(new Error('runtime failure')), 70);
});

test('krn --version reports the package version', () => {
  const result = spawnSync(process.execPath, [cli, '--version'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'krn 0.1.0\n');
});

test('unknown commands forward arguments, streams, and exit code to the legacy binary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-'));
  try {
    const legacy = join(directory, 'legacy.mjs');
    await writeFile(
      legacy,
      [
        'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), forwarded: process.env.KRN_FORWARDED }));',
        "process.stderr.write('legacy stderr\\n');",
        'process.exitCode = 23;',
      ].join('\n'),
    );
    const result = spawnSync(process.execPath, [cli, 'legacy-command', 'one'], {
      encoding: 'utf8',
      env: { ...process.env, KRN_LEGACY_ENTRY: legacy, KRN_FORWARDED: '' },
    });
    assert.equal(result.status, 23);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ['legacy-command', 'one'],
      forwarded: '1',
    });
    assert.equal(result.stderr, 'legacy stderr\n');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('forwarding guard blocks a recursive legacy invocation', () => {
  const result = spawnSync(process.execPath, [cli, 'legacy-command'], {
    encoding: 'utf8',
    env: { ...process.env, KRN_LEGACY_ENTRY: cli, KRN_FORWARDED: '' },
  });
  assert.equal(result.status, 70);
  assert.match(result.stderr, /recursion blocked/u);
});

test('legacy entry defaults under the current Codex installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-home-'));
  try {
    const legacy = join(directory, '.codex/krn/current/scripts/krn.mjs');
    await mkdir(join(directory, '.codex/krn/current/scripts'), {
      recursive: true,
    });
    await writeFile(legacy, "process.stdout.write('default legacy');");
    const result = spawnSync(process.execPath, [cli, 'legacy-command'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        KRN_LEGACY_ENTRY: '',
        KRN_FORWARDED: '',
      },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'default legacy');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('realpath recursion guard blocks a symlink to the CLI itself', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-link-'));
  try {
    const alias = join(directory, 'legacy-link.mjs');
    await symlink(cli, alias);
    const result = spawnSync(process.execPath, [cli, 'legacy-command'], {
      encoding: 'utf8',
      env: { ...process.env, KRN_LEGACY_ENTRY: alias, KRN_FORWARDED: '' },
    });
    assert.equal(result.status, 70);
    assert.match(result.stderr, /recursion blocked/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

function fixtureGit(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...cleanGitEnvironment(), GIT_OPTIONAL_LOCKS: '0' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fileTreeSnapshot(root: string): Array<[string, string]> | null {
  if (!existsSync(root)) return null;
  const files: Array<[string, string]> = [];
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        files.push([relative, `symlink:${readlinkSync(path)}`]);
      else if (entry.isDirectory()) visit(path, relative);
      else if (entry.isFile())
        files.push([
          relative,
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        ]);
      else files.push([relative, 'special-file']);
    }
  };
  visit(root, '');
  return files;
}

function journeyEvents(jobId: string, headSha: string): string {
  const rows = [
    {
      id: 'intent-one',
      key: 'intent:1',
      kind: 'intent',
      at: '2026-10-19T00:00:00.000Z',
      data: { jobId, epoch: 1 },
    },
    {
      id: 'started-one',
      key: 'intent:1:session',
      kind: 'session_started',
      at: '2026-10-19T00:00:01.000Z',
      data: {
        intent: 'intent:1',
        jobId,
        sessionId: 'interrupted-session',
        isolation: 'systemd_scope',
      },
    },
    {
      id: 'ended-one',
      key: 'intent:1:ended:interrupted-session',
      kind: 'session_ended',
      at: '2026-10-19T00:00:02.000Z',
      data: {
        intent: 'intent:1',
        sessionId: 'interrupted-session',
        end: {
          exitCode: null,
          signal: 'SIGTERM',
          reasonKind: 'process_exit',
          claimsDone: false,
          usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
          usageObservation: {
            turnsStarted: 1,
            turnsCompleted: 0,
            invalidFields: 0,
          },
        },
      },
    },
    {
      id: 'outcome-stop',
      key: 'job-outcome:00000000-0000-4000-8000-000000000001',
      kind: 'job_outcome',
      at: '2026-10-19T00:00:03.000Z',
      data: {
        exitCode: 130,
        signal: 'SIGTERM',
        cleanup: 'verified',
        reason: 'stopped',
        outcomeKind: 'stop',
      },
    },
    {
      id: 'operator-start',
      key: 'operator-start:1',
      kind: 'operator_start',
      at: '2026-10-19T00:00:04.000Z',
      data: { operator: 'lead' },
    },
    {
      id: 'intervention',
      key: 'lead-intervention:1',
      kind: 'lead_intervention',
      at: '2026-10-19T00:00:05.000Z',
      data: { kind: 'intervention', note: 'bounded intervention' },
    },
    {
      id: 'reconstruction',
      key: 'lead-intervention:2',
      kind: 'lead_intervention',
      at: '2026-10-19T00:00:06.000Z',
      data: { kind: 'reconstruction_prompt', note: 'bounded reconstruction' },
    },
    {
      id: 'operator-stop',
      key: 'operator-stop:1',
      kind: 'operator_stop',
      at: '2026-10-19T00:00:07.000Z',
      data: { operator: 'lead' },
    },
    {
      id: 'intent-two',
      key: 'intent:2',
      kind: 'intent',
      at: '2026-10-19T00:00:08.000Z',
      data: { jobId, epoch: 2 },
    },
    {
      id: 'started-two',
      key: 'intent:2:session',
      kind: 'session_started',
      at: '2026-10-19T00:00:09.000Z',
      data: {
        intent: 'intent:2',
        jobId,
        sessionId: 'resumed-session',
        isolation: 'systemd_scope',
      },
    },
    {
      id: 'ended-two',
      key: 'intent:2:ended:resumed-session',
      kind: 'session_ended',
      at: '2026-10-19T00:00:10.000Z',
      data: {
        intent: 'intent:2',
        sessionId: 'resumed-session',
        end: {
          exitCode: 0,
          signal: null,
          reasonKind: 'exit',
          claimsDone: true,
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          usageObservation: {
            turnsStarted: 1,
            turnsCompleted: 1,
            invalidFields: 0,
          },
        },
      },
    },
    {
      id: 'checkpoint-two',
      key: 'intent:2:checkpoint:resumed-session',
      kind: 'checkpoint',
      at: '2026-10-19T00:00:11.000Z',
      data: {
        intent: 'intent:2',
        sessionId: 'resumed-session',
        message: 'finished',
        next: 'done',
      },
    },
    {
      id: 'commit-two',
      key: 'intent:2:commit:resumed-session',
      kind: 'commit',
      at: '2026-10-19T00:00:12.000Z',
      data: {
        intent: 'intent:2',
        sessionId: 'resumed-session',
        sha: headSha,
        message: 'feat: finish journey',
      },
    },
    {
      id: 'outcome-complete',
      key: 'job-outcome:00000000-0000-4000-8000-000000000002',
      kind: 'job_outcome',
      at: '2026-10-19T00:00:13.000Z',
      data: {
        exitCode: 0,
        signal: null,
        cleanup: 'verified',
        reason: 'completed',
        outcomeKind: 'review',
      },
    },
  ];
  return `${rows.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

test('krn report journey emits honest resumed facts without repository writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-journey-'));
  const repo = join(directory, 'repo');
  const jobId = 'journey-cli-test';
  const jobDirectory = join(repo, '.krn/runs/foreman', jobId);
  const silentLegacy = join(directory, 'silent-legacy.mjs');
  const hostileConfig = join(directory, 'hostile.gitconfig');
  const fsmonitor = join(directory, 'fsmonitor-probe');
  const fsmonitorMarker = join(directory, 'fsmonitor-ran');
  const foreignIndex = join(directory, 'foreign-index');
  try {
    await mkdir(repo, { recursive: true });
    fixtureGit(repo, 'init', '--quiet');
    fixtureGit(repo, 'config', 'user.name', 'KRN journey fixture');
    fixtureGit(repo, 'config', 'user.email', 'journey@example.invalid');
    await writeFile(join(repo, '.gitignore'), '.krn/\n');
    await writeFile(join(repo, 'README.md'), 'journey fixture\n');
    fixtureGit(repo, 'add', '.gitignore', 'README.md');
    fixtureGit(repo, 'commit', '-qm', 'create journey fixture');
    const headSha = fixtureGit(repo, 'rev-parse', 'HEAD');
    const indexPath = join(
      repo,
      fixtureGit(repo, 'rev-parse', '--git-path', 'index'),
    );

    await mkdir(jobDirectory, { recursive: true });
    const traceBytes = Buffer.from(journeyEvents(jobId, headSha));
    const tracePath = join(jobDirectory, 'trace.jsonl');
    await writeFile(tracePath, traceBytes);
    const staleJobId = 'journey-uncertain-test';
    const staleJobDirectory = join(repo, '.krn/runs/foreman', staleJobId);
    await mkdir(staleJobDirectory, { recursive: true });
    await writeFile(
      join(staleJobDirectory, 'trace.jsonl'),
      `${JSON.stringify({
        id: 'unconfirmed',
        key: 'job-outcome:00000000-0000-4000-8000-000000000003',
        kind: 'job_outcome',
        at: '2026-10-19T00:00:00.000Z',
        data: {
          exitCode: 1,
          signal: null,
          cleanup: 'unconfirmed',
          reason: 'cleanup-unconfirmed',
        },
      })}\n`,
    );
    await writeFile(silentLegacy, 'process.exitCode = 0;\n');
    await writeFile(
      fsmonitor,
      `#!/bin/sh\nprintf invoked > '${fsmonitorMarker}'\nexit 0\n`,
      { mode: 0o755 },
    );
    await writeFile(hostileConfig, `[core]\n\tfsmonitor = ${fsmonitor}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KRN_LEGACY_ENTRY: silentLegacy,
      KRN_FORWARDED: '',
      GIT_DIR: join(directory, 'foreign-git-dir'),
      GIT_WORK_TREE: join(directory, 'foreign-work-tree'),
      GIT_COMMON_DIR: join(directory, 'foreign-common-dir'),
      GIT_INDEX_FILE: foreignIndex,
      GIT_OBJECT_DIRECTORY: join(directory, 'foreign-objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(directory, 'foreign-alternates'),
      GIT_CEILING_DIRECTORIES: directory,
      GIT_OPTIONAL_LOCKS: '1',
      GIT_CONFIG_GLOBAL: hostileConfig,
      GIT_CONFIG_NOSYSTEM: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: fsmonitor,
    };
    const runsRoot = join(repo, '.krn/runs');
    const beforeRuns = fileTreeSnapshot(runsRoot);
    const beforeIndexBytes = readFileSync(indexPath);
    const beforeIndexStat = statSync(indexPath);
    const runCli = (job: string) =>
      spawnSync(
        process.execPath,
        [cli, 'report', 'journey', '--repo', repo, '--job', job],
        { encoding: 'utf8', env },
      );

    const journey = runCli(jobId);
    assert.equal(journey.status, 0, journey.stderr);
    assert.match(
      journey.stdout,
      /\S/u,
      'report journey must be recognized instead of silently forwarded',
    );
    const report = JSON.parse(journey.stdout) as {
      kind: string;
      facts: {
        trace: { sha256: string };
        git: { headSha: string; isDirty: boolean };
        resumed: { sessionId: string; commitSha: string };
        usage: { totalTokens: number | null; unknownSessions: string[] };
        operatorWindow: {
          interventions: number | null;
          reconstructionPrompts: number | null;
        };
      };
      checks: unknown[];
    };
    assert.equal(report.kind, 'journey');
    assert.equal(
      report.facts.trace.sha256,
      createHash('sha256').update(traceBytes).digest('hex'),
    );
    assert.equal(report.facts.git.headSha, headSha);
    assert.equal(report.facts.git.isDirty, false);
    assert.equal(report.facts.resumed.sessionId, 'resumed-session');
    assert.equal(report.facts.resumed.commitSha, headSha);
    assert.equal(report.facts.usage.totalTokens, null);
    assert.deepEqual(report.facts.usage.unknownSessions, [
      'interrupted-session',
    ]);
    assert.equal(report.facts.operatorWindow.interventions, 1);
    assert.equal(report.facts.operatorWindow.reconstructionPrompts, 1);
    assert.ok(Array.isArray(report.checks));

    const refusal = runCli(staleJobId);
    assert.equal(refusal.status, 1);
    assert.match(refusal.stdout, /\S/u);
    const refused = JSON.parse(refusal.stdout) as {
      kind: string;
      code: string;
      facts: { git: { headSha: string } };
    };
    assert.equal(refused.kind, 'refusal');
    assert.equal(refused.code, 'cleanup_unconfirmed');
    assert.equal(refused.facts.git.headSha, headSha);

    assert.deepEqual(fileTreeSnapshot(runsRoot), beforeRuns);
    assert.deepEqual(readFileSync(tracePath), traceBytes);
    assert.deepEqual(readFileSync(indexPath), beforeIndexBytes);
    const afterIndexStat = statSync(indexPath);
    assert.equal(afterIndexStat.dev, beforeIndexStat.dev);
    assert.equal(afterIndexStat.ino, beforeIndexStat.ino);
    assert.equal(afterIndexStat.size, beforeIndexStat.size);
    assert.equal(afterIndexStat.mtimeMs, beforeIndexStat.mtimeMs);
    assert.equal(existsSync(foreignIndex), false);
    assert.equal(existsSync(fsmonitorMarker), false);
    assert.equal(
      existsSync(join(repo, '.krn/runs/delivery-loop', jobId)),
      false,
    );
    assert.equal(existsSync(join(jobDirectory, 'capsule.json')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('krn report journey reads HEAD from the registered job worktree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-journey-worktree-'));
  const repo = join(directory, 'repo');
  const jobId = 'journey-worktree-test';
  const jobWorktree = join(repo, '.krn/worktrees', jobId);
  const jobDirectory = join(repo, '.krn/runs/foreman', jobId);
  try {
    await mkdir(repo, { recursive: true });
    fixtureGit(repo, 'init', '--quiet');
    fixtureGit(repo, 'config', 'user.name', 'KRN journey fixture');
    fixtureGit(repo, 'config', 'user.email', 'journey@example.invalid');
    await writeFile(join(repo, '.gitignore'), '.krn/\n');
    await writeFile(join(repo, 'README.md'), 'main checkout\n');
    fixtureGit(repo, 'add', '.gitignore', 'README.md');
    fixtureGit(repo, 'commit', '-qm', 'create main journey fixture');
    const mainHead = fixtureGit(repo, 'rev-parse', 'HEAD');

    fixtureGit(
      repo,
      'worktree',
      'add',
      '--quiet',
      '-b',
      `krn/${jobId}`,
      jobWorktree,
      mainHead,
    );
    fixtureGit(jobWorktree, 'config', 'user.name', 'KRN job fixture');
    fixtureGit(jobWorktree, 'config', 'user.email', 'job@example.invalid');
    await writeFile(join(jobWorktree, 'README.md'), 'job worktree commit\n');
    fixtureGit(jobWorktree, 'add', 'README.md');
    fixtureGit(jobWorktree, 'commit', '-qm', 'commit in job worktree');
    const jobHead = fixtureGit(jobWorktree, 'rev-parse', 'HEAD');
    assert.notEqual(jobHead, mainHead);

    const record = recordRepo(
      { id: jobId, issue: 'LON-292', worktree: jobWorktree, repoRoot: repo },
      repo,
      `krn/${jobId}`,
      mainHead,
    );
    assert.equal(record.gitWorkTree, jobWorktree);
    await writeFile(join(jobWorktree, 'README.md'), 'job worktree dirty\n');
    await mkdir(jobDirectory, { recursive: true });
    const rows = journeyEvents(jobId, jobHead)
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const interruptedEnd = rows.find(
      (event) => event.kind === 'session_ended' && event.id === 'ended-one',
    );
    assert.ok(interruptedEnd);
    const end = interruptedEnd.data as {
      end: {
        reasonKind: string;
        usageObservation: { turnsStarted: number; turnsCompleted: number };
      };
    };
    end.end.reasonKind = 'process_exit';
    end.end.usageObservation.turnsCompleted = 0;
    const traceBytes = Buffer.from(
      `${rows.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
    const tracePath = join(jobDirectory, 'trace.jsonl');
    await writeFile(tracePath, traceBytes);

    const indexPath = join(
      repo,
      fixtureGit(repo, 'rev-parse', '--git-path', 'index'),
    );
    const beforeIndex = readFileSync(indexPath);
    const beforeIndexStat = statSync(indexPath);
    const jobIndexPath = fixtureGit(
      jobWorktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index',
    );
    const beforeJobIndex = readFileSync(jobIndexPath);
    const beforeJobIndexStat = statSync(jobIndexPath);
    const runsRoot = join(repo, '.krn/runs');
    const beforeRuns = fileTreeSnapshot(runsRoot);
    const result = spawnSync(
      process.execPath,
      [cli, 'report', 'journey', '--repo', repo, '--job', jobId],
      { encoding: 'utf8', env: cleanGitEnvironment() },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      kind: string;
      facts: {
        git: { headSha: string; isDirty: boolean };
        resumed: { commitSha: string };
        usage: { totalTokens: number | null; unknownSessions: string[] };
      };
    };
    assert.equal(report.kind, 'journey');
    assert.equal(report.facts.git.headSha, jobHead);
    assert.equal(report.facts.git.isDirty, true);
    assert.equal(report.facts.resumed.commitSha, jobHead);
    assert.equal(report.facts.usage.totalTokens, null);
    assert.deepEqual(report.facts.usage.unknownSessions, [
      'interrupted-session',
    ]);
    assert.deepEqual(readFileSync(tracePath), traceBytes);
    assert.deepEqual(
      readFileSync(join(jobDirectory, 'repo.json')),
      Buffer.from(JSON.stringify(record)),
    );
    assert.deepEqual(fileTreeSnapshot(runsRoot), beforeRuns);
    assert.deepEqual(readFileSync(indexPath), beforeIndex);
    assert.deepEqual(readFileSync(jobIndexPath), beforeJobIndex);
    const afterIndexStat = statSync(indexPath);
    assert.equal(afterIndexStat.dev, beforeIndexStat.dev);
    assert.equal(afterIndexStat.ino, beforeIndexStat.ino);
    assert.equal(afterIndexStat.size, beforeIndexStat.size);
    assert.equal(afterIndexStat.mtimeMs, beforeIndexStat.mtimeMs);
    const afterJobIndexStat = statSync(jobIndexPath);
    assert.equal(afterJobIndexStat.dev, beforeJobIndexStat.dev);
    assert.equal(afterJobIndexStat.ino, beforeJobIndexStat.ino);
    assert.equal(afterJobIndexStat.size, beforeJobIndexStat.size);
    assert.equal(afterJobIndexStat.mtimeMs, beforeJobIndexStat.mtimeMs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('krn report journey refuses foreign and symlinked repository descriptors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-journey-record-'));
  const repo = join(directory, 'repo');
  const foreignJob = 'journey-foreign-record';
  const symlinkJob = 'journey-symlink-record';
  const externalRecord = join(directory, 'external-repo-record.json');
  try {
    await mkdir(repo, { recursive: true });
    fixtureGit(repo, 'init', '--quiet');
    fixtureGit(repo, 'config', 'user.name', 'KRN descriptor fixture');
    fixtureGit(repo, 'config', 'user.email', 'record@example.invalid');
    await writeFile(join(repo, '.gitignore'), '.krn/\n');
    await writeFile(join(repo, 'README.md'), 'descriptor fixture\n');
    fixtureGit(repo, 'add', '.gitignore', 'README.md');
    fixtureGit(repo, 'commit', '-qm', 'create descriptor fixture');
    fixtureGit(repo, 'rev-parse', 'HEAD');

    const foreignDirectory = join(repo, '.krn/runs/foreman', foreignJob);
    await mkdir(foreignDirectory, { recursive: true });
    const foreignBytes = Buffer.from(
      JSON.stringify({
        repoRoot: join(directory, 'foreign-root'),
        gitDir: join(directory, 'foreign-root/.git'),
        gitWorkTree: join(directory, 'foreign-root/worktree'),
      }),
    );
    await writeFile(join(foreignDirectory, 'repo.json'), foreignBytes);

    const symlinkDirectory = join(repo, '.krn/runs/foreman', symlinkJob);
    await mkdir(symlinkDirectory, { recursive: true });
    const externalBytes = Buffer.from(
      JSON.stringify({
        repoRoot: repo,
        gitDir: join(repo, '.git'),
        gitWorkTree: repo,
      }),
    );
    await writeFile(externalRecord, externalBytes);
    await symlink(externalRecord, join(symlinkDirectory, 'repo.json'));
    const beforeRuns = fileTreeSnapshot(join(repo, '.krn/runs'));

    const runCli = (jobId: string) =>
      spawnSync(
        process.execPath,
        [cli, 'report', 'journey', '--repo', repo, '--job', jobId],
        { encoding: 'utf8', env: cleanGitEnvironment() },
      );
    const foreign = runCli(foreignJob);
    const symlinked = runCli(symlinkJob);
    const reports = [foreign, symlinked].map((result) => {
      assert.equal(result.status, 1, result.stderr);
      return JSON.parse(result.stdout) as { kind: string; code: string };
    });
    assert.deepEqual(
      reports.map(({ kind, code }) => ({ kind, code })),
      [
        { kind: 'refusal', code: 'git_unavailable' },
        { kind: 'refusal', code: 'git_unavailable' },
      ],
    );
    assert.deepEqual(
      readFileSync(join(foreignDirectory, 'repo.json')),
      foreignBytes,
    );
    assert.deepEqual(readFileSync(externalRecord), externalBytes);
    assert.deepEqual(fileTreeSnapshot(join(repo, '.krn/runs')), beforeRuns);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
