import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  namesRemedy,
  nextSteps,
  packRemedyCommand,
  type StepResult,
  stepCommands,
  summarize,
} from './lib/first-day-walkthrough.ts';

// Day one in a real repository: init an empty directory, adopt a public clone,
// run every printed next step, doctor, task create, lane brief (no worker), and
// probe that the common failures name their remedy. Usage:
//   node scripts/first-day-walkthrough.ts [PUBLIC_GIT_URL]
// The work directory (clone included) goes under $KRN_WALKTHROUGH_TMP, else the
// system temp dir, and is deleted at the end.
const root = resolve(dirname(import.meta.filename), '..');
const url = process.argv[2] ?? 'https://github.com/thlorenz/parse-link-header';
const publicDir = process.env.KRN_WALKTHROUGH_TMP ?? tmpdir();
mkdirSync(publicDir, { recursive: true });
const work = mkdtempSync(join(publicDir, 'first-day-'));
const binDir = join(work, 'bin');
mkdirSync(binDir);
symlinkSync(join(root, 'bin', 'krn'), join(binDir, 'krn'));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${binDir}:${process.env.PATH}`,
  KRN_ADOPTED_REGISTRY: join(work, 'registry.json'),
  GIT_AUTHOR_NAME: 'walkthrough',
  GIT_AUTHOR_EMAIL: 'walkthrough@example.invalid',
  GIT_COMMITTER_NAME: 'walkthrough',
  GIT_COMMITTER_EMAIL: 'walkthrough@example.invalid',
};
for (const name of ['KRN_SESSION_CLASS', 'KRN_LANE', 'KRN_TASK'])
  delete env[name];

const results: StepResult[] = [];

function sh(cwd: string, command: string, input = '') {
  const run = spawnSync('bash', ['-c', command], {
    cwd,
    env,
    input,
    encoding: 'utf8',
    timeout: 300_000,
  });
  return { code: run.status ?? 1, out: `${run.stdout}${run.stderr}` };
}

function expect(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail: ok ? '' : detail.trim().slice(0, 400) });
  return ok;
}

function runSteps(label: string, dir: string, output: string) {
  const steps = nextSteps(output);
  expect(`${label}: adopt printed next steps`, steps.length > 0, output);
  for (const step of steps)
    for (const command of stepCommands(step)) {
      const run = sh(dir, command);
      expect(
        `${label}: next step \`${command}\``,
        run.code === 0,
        `exit ${run.code}: ${run.out}`,
      );
    }
}

// Day two in the adopted directory: the pack grew (one pack record is missing
// from .agents/standards.json), doctor names the remedy, the remedy refreshes,
// and the task opened on day one is still open and its lane brief resumes it.
// Doctor ORs the host entry-pin exit (78 while the host's Product entry lags
// origin/main) into its own; that host state is not the pack's, so the pack
// lines decide and the exit must equal the wanted code only on a fresh entry.
function exitIs(run: { code: number; out: string }, want: number) {
  return /^status=stale$|^entry=unconfigured$/mu.test(run.out)
    ? run.code === 78
    : run.code === want;
}

function secondDay(dir: string, id: string | undefined) {
  const file = join(dir, '.agents', 'standards.json');
  const records = JSON.parse(readFileSync(file, 'utf8')) as {
    id: string;
    layer: string;
  }[];
  const dropped = records.find((record) => record.layer === 'universal');
  expect('second day: a pack record to drop exists', !!dropped, file);
  writeFileSync(
    file,
    `${JSON.stringify(
      records.filter((record) => record !== dropped),
      null,
      2,
    )}\n`,
  );
  const stale = sh(dir, 'krn doctor');
  expect(
    'second day: doctor on a stale pack exits 65 naming the record',
    exitIs(stale, 65) &&
      stale.out.includes('pack-stale=') &&
      stale.out.includes(dropped?.id ?? '?'),
    `exit ${stale.code}: ${stale.out}`,
  );
  const remedy = packRemedyCommand(stale.out);
  expect(
    'second day: doctor prints the refresh command',
    remedy !== undefined,
    stale.out,
  );
  if (remedy !== undefined) {
    const refreshed = sh(dir, remedy);
    expect(
      `second day: remedy \`${remedy}\` exits 0`,
      refreshed.code === 0,
      `exit ${refreshed.code}: ${refreshed.out}`,
    );
  }
  const after = sh(dir, 'krn doctor');
  expect(
    'second day: doctor is current after the refresh',
    exitIs(after, 0) && after.out.includes('pack=current'),
    `exit ${after.code}: ${after.out}`,
  );
  const shown = sh(dir, `krn task show ${id ?? 't-none'}`);
  expect(
    'second day: the day-one task is still open',
    shown.code === 0 && /Status: open/u.test(shown.out),
    shown.out,
  );
  const brief = sh(
    dir,
    `krn lane brief --task ${id ?? 't-none'}`,
    'Resume the first task.',
  );
  expect(
    'second day: lane brief resumes the open task',
    brief.code === 0 && brief.out.includes(`Ticket: ${id}`),
    brief.out,
  );
}

function walk() {
  const empty = join(work, 'empty');
  mkdirSync(empty);
  const plain = join(work, 'plain');
  mkdirSync(plain);
  const nonRepo = sh(plain, 'krn adopt .');
  expect(
    'adopt on a non-repository names git init and --init --stack',
    nonRepo.code !== 0 &&
      /git init/u.test(nonRepo.out) &&
      /--init --stack/u.test(nonRepo.out),
    nonRepo.out,
  );
  const noStack = sh(empty, 'krn adopt . --init');
  expect(
    'empty dir without a stack fails naming --stack',
    noStack.code !== 0 && /--stack/u.test(noStack.out),
    noStack.out,
  );
  const init = sh(empty, 'krn adopt . --init --stack ts');
  expect('init: adopt --init --stack ts exits 0', init.code === 0, init.out);
  runSteps('init', empty, init.out);
  expect(
    'init: doctor exits 0',
    sh(empty, 'krn doctor').code === 0,
    'krn doctor failed',
  );
  const created = sh(empty, 'krn task create --title "First task" --json');
  const id = /"id":\s*"(t-[a-z0-9]+)"/u.exec(created.out)?.[1];
  expect('init: task create exits 0', created.code === 0 && !!id, created.out);
  const brief = sh(
    empty,
    `krn lane brief --task ${id ?? 't-none'}`,
    'Add one test.',
  );
  expect(
    'init: lane brief names the task trailer',
    brief.code === 0 && brief.out.includes(`Ticket: ${id}`),
    brief.out,
  );
  secondDay(empty, id);

  const clone = join(work, 'clone');
  const cloned = sh(work, `git clone -q --depth 1 ${url} clone`);
  if (!expect('public clone succeeds', cloned.code === 0, cloned.out)) return;
  const adopt = sh(clone, 'krn adopt .');
  expect('clone: adopt exits 0', adopt.code === 0, adopt.out);
  runSteps('clone', clone, adopt.out);
  const contract = sh(clone, 'krn repo contract');
  expect('clone: repo contract exits 0', contract.code === 0, contract.out);
  expect('clone: doctor exits 0', sh(clone, 'krn doctor').code === 0, 'failed');

  const probes: [string, string, number | null][] = [
    ['unknown command', 'krn frobnicate', 64],
    ['missing task', 'krn task show t-nope000', null],
    ['empty lane brief', 'krn lane brief </dev/null', 64],
    ['lane without origin', 'krn lane start probe', 64],
    ['lane run without origin', `krn lane run --task ${id ?? 't-none'}`, 69],
    ['dropping an absent lane', 'krn lane drop nothing', 64],
  ];
  for (const [name, command, code] of probes) {
    const run = sh(empty, command);
    expect(
      `failure names its remedy: ${name}`,
      run.code !== 0 &&
        (code === null || run.code === code) &&
        namesRemedy(run.out),
      `exit ${run.code}: ${run.out}`,
    );
  }
}

try {
  walk();
} finally {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}
const { text, exitCode } = summarize(results);
console.log(text);
process.exit(exitCode);
