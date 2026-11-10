// FR-40 runner: for every planned run, clone a scratch repository at the task base,
// commit the task's setup files, compose the arm's prompt, then run `krn eval session`
// and `krn eval score` against that slot. Completed runs (score.json present) are skipped,
// so an interrupted campaign resumes where it stopped.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fr40Manifest, loadManifest } from '../../src/evals/manifest.ts';
import { planExperiment } from '../../src/evals/plan.ts';
import type { ConventionTask, Template } from './tasks.ts';

type Arm = 'A' | 'B' | 'S';
type Material = Readonly<Record<string, { packet: string; standards: string }>>;
export type PlannedRun = {
  readonly task: string;
  readonly replica: number;
  readonly arm: string;
  readonly runId: string;
};

const experiment = fileURLToPath(new URL('.', import.meta.url));
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const IDENTITY = {
  GIT_AUTHOR_NAME: 'fr40 setup',
  GIT_AUTHOR_EMAIL: 'fr40@example.invalid',
  GIT_AUTHOR_DATE: '2026-11-08T00:00:00Z',
  GIT_COMMITTER_NAME: 'fr40 setup',
  GIT_COMMITTER_EMAIL: 'fr40@example.invalid',
  GIT_COMMITTER_DATE: '2026-11-08T00:00:00Z',
};

/** Arm A gets the task prompt alone; B and S get their material, a blank line, then the prompt. */
export function composePrompt(
  task: ConventionTask,
  arm: Arm,
  material: Material,
): string {
  const prompt = `${task.prompt.trim()}\n`;
  if (arm === 'A') return prompt;
  const entry = material[task.id];
  if (!entry) throw new Error(`no material for ${task.id}`);
  const text = arm === 'B' ? entry.packet : entry.standards;
  return `${text.trim()}\n\n${prompt}`;
}

/** Strata alternate so any prefix of the campaign samples every convention (round-robin by template). */
export function campaignOrder(
  runs: readonly PlannedRun[],
  tasks: readonly ConventionTask[],
): PlannedRun[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rank = new Map<Template, number>();
  const position = new Map<string, number>();
  for (const task of tasks) {
    const seen = rank.get(task.template) ?? 0;
    position.set(task.id, seen);
    rank.set(task.template, seen + 1);
  }
  const templates = [...new Set(tasks.map((task) => task.template))];
  const key = (run: PlannedRun) => {
    const task = byId.get(run.task);
    if (!task) throw new Error(`unknown task ${run.task}`);
    return [position.get(task.id) ?? 0, templates.indexOf(task.template)];
  };
  return runs
    .map((run, index) => ({ run, index, key: key(run) }))
    .sort(
      (a, b) =>
        (a.key[0] ?? 0) - (b.key[0] ?? 0) ||
        (a.key[1] ?? 0) - (b.key[1] ?? 0) ||
        a.index - b.index,
    )
    .map(({ run }) => run);
}

function git(repo: string, args: readonly string[], env = {}): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
}

/** Clone `source` at the task base into `<slot>/repo`, commit setup files; returns the scoring base. */
export async function prepareSlot(
  source: string,
  slot: string,
  task: ConventionTask,
): Promise<string> {
  const repo = join(slot, 'repo');
  await mkdir(slot, { recursive: true });
  execFileSync('git', ['clone', '-q', '--no-checkout', source, repo]);
  git(repo, ['checkout', '-q', '-B', 'main', task.base]);
  git(repo, ['remote', 'remove', 'origin']);
  // The session commits as a fixed agent identity; the mask hides the operator's config.
  git(repo, ['config', 'user.name', 'fr40 agent']);
  git(repo, ['config', 'user.email', 'agent@example.invalid']);
  // A private copy of the dependencies, so `npm run fast` and Biome work inside the mask.
  const modules = join(source, 'node_modules');
  if (existsSync(modules))
    execFileSync('cp', ['-a', '--reflink=auto', modules, repo]);
  if (task.setup.length === 0) return task.base;
  for (const file of task.setup) {
    await mkdir(dirname(join(repo, file.path)), { recursive: true });
    await writeFile(join(repo, file.path), file.content);
  }
  git(repo, ['add', '--', ...task.setup.map((file) => file.path)]);
  git(repo, ['commit', '-q', '-m', 'Set up the task'], IDENTITY);
  return git(repo, ['rev-parse', 'HEAD']);
}

function cliRun(args: readonly string[]): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.once('close', (code) => done(code ?? 70));
    child.once('error', () => done(70));
  });
}

type Options = {
  readonly root: string;
  readonly slots: string;
  readonly source: string;
  readonly jobs: number;
  readonly limit: number;
  readonly keepSlots: boolean;
  readonly configSha256: string;
};

// These bytes (including the pinned model) are hashed as the session's config.
// Empty config homes plus the mask remove ambient MCP, skills and history.
// The mask is the isolation boundary; Codex's own workspace-write sandbox would make
// .git read-only, so a session could not commit, and every FR-40 convention reads commits.
export const CODEX_CONFIG = `approval_policy = "never"
sandbox_mode = "danger-full-access"
cli_auth_credentials_store = "file"
web_search = "disabled"
[history]
persistence = "none"
[features]
apps = false
plugins = false
remote_plugin = false
skill_search = false
skill_mcp_dependency_install = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
computer_use = false
image_generation = false
hooks = false
memories = false
`;

/** sha256 of the config a lane session writes for an arm model. */
/** Where a run's evidence lands. */
export function runDirectory(root: string, experiment: string, runId: string) {
  return join(root, experiment, 'runs', runId);
}

export function configSha256(model: string): string {
  return createHash('sha256')
    .update(`model = ${JSON.stringify(model)}\n${CODEX_CONFIG}`)
    .digest('hex');
}

function sessionConfig(output: string): string | undefined {
  try {
    const session = JSON.parse(
      readFileSync(join(output, 'session.json'), 'utf8'),
    ) as { configSha256?: unknown };
    return typeof session.configSha256 === 'string'
      ? session.configSha256
      : undefined;
  } catch {
    return undefined;
  }
}

async function runOne(
  run: PlannedRun,
  task: ConventionTask,
  material: Material,
  options: Options,
): Promise<string> {
  const output = runDirectory(options.root, 'fr40', run.runId);
  const config = sessionConfig(output);
  if (config !== undefined && config !== options.configSha256) {
    // A session under another harness config is not this experiment's run: set it aside and redo it.
    const invalid = join(options.root, 'fr40', 'invalid');
    await mkdir(invalid, { recursive: true });
    await rename(output, join(invalid, `${run.runId}-${config.slice(0, 12)}`));
  } else if (existsSync(join(output, 'score.json'))) return 'done';
  const slot = join(options.slots, run.runId);
  const prompt = join(options.slots, `${run.runId}.prompt.md`);
  const baseFile = join(options.slots, `${run.runId}.base`);
  if (!existsSync(join(output, 'session.json'))) {
    // An interrupted session left no verdict; it restarts from a fresh slot.
    await rm(output, { recursive: true, force: true });
    await rm(slot, { recursive: true, force: true });
    const base = await prepareSlot(options.source, slot, task);
    await writeFile(baseFile, `${base}\n`);
    await writeFile(prompt, composePrompt(task, run.arm as Arm, material));
    await cliRun([
      'eval',
      'session',
      '--experiment',
      experiment,
      '--root',
      options.root,
      '--run',
      run.runId,
      '--slot',
      slot,
      '--prompt-file',
      prompt,
    ]);
    if (!existsSync(join(output, 'session.json'))) return 'no-session';
  }
  const base = readFileSync(baseFile, 'utf8').trim();
  const repo = join(slot, 'repo');
  await writeFile(
    join(output, 'repo.patch'),
    `${git(repo, ['log', '-p', '--format=commit %H%n%B', `${base}..HEAD`])}\n--- status\n${git(repo, ['status', '--porcelain', '--untracked-files=all'])}\n`,
  );
  const code = await cliRun([
    'eval',
    'score',
    '--experiment',
    experiment,
    '--root',
    options.root,
    '--run',
    run.runId,
    '--slot',
    slot,
    ...(base === task.base ? [] : ['--base', base]),
  ]);
  if (code === 0 && !options.keepSlots)
    await rm(slot, { recursive: true, force: true });
  return code === 0 ? 'scored' : `score-exit-${code}`;
}

async function main(argv: readonly string[]): Promise<void> {
  const flag = (name: string) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const root = flag('--root');
  const slots = flag('--slots');
  if (!root || !slots) {
    process.stderr.write(
      'usage: run.ts --root <evidence dir> --slots <dir> [--source <repo>] [--jobs <n>] [--limit <n>] [--only <runId>] [--keep-slots]\n',
    );
    process.exit(64);
  }
  const partial = {
    root: resolve(root),
    slots: resolve(slots),
    // The main checkout: it holds the dependencies a linked worktree lacks.
    source: resolve(
      flag('--source') ??
        dirname(
          git(experiment, [
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ]),
        ),
    ),
    jobs: Number(flag('--jobs') ?? '1'),
    limit: Number(flag('--limit') ?? 'Infinity'),
    keepSlots: argv.includes('--keep-slots'),
  };
  const manifest = fr40Manifest(await loadManifest(experiment));
  const models = new Set(manifest.arms.map((arm) => arm.model));
  const [model] = models;
  if (models.size !== 1 || model === undefined)
    throw new Error('FR-40 arms must share one model');
  const options: Options = { ...partial, configSha256: configSha256(model) };
  const tasks = JSON.parse(
    readFileSync(join(experiment, manifest.taskFile), 'utf8'),
  ) as ConventionTask[];
  const material = JSON.parse(
    readFileSync(join(experiment, manifest.material), 'utf8'),
  ) as Material;
  const only = flag('--only');
  const queue = campaignOrder(planExperiment(manifest).runs, tasks)
    .filter((run) => only === undefined || run.runId === only)
    .slice(0, options.limit);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  await mkdir(options.slots, { recursive: true });
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const run = queue[next++];
      const task = run && byId.get(run.task);
      if (!run || !task) continue;
      const started = Date.now();
      const result = await runOne(run, task, material, options);
      process.stdout.write(
        `${new Date().toISOString()} ${run.runId.slice(0, 12)} ${run.task} ${run.arm} ${result} ${Math.round((Date.now() - started) / 1000)}s\n`,
      );
    }
  };
  await Promise.all(Array.from({ length: options.jobs }, worker));
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
