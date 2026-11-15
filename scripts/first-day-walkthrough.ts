import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  namesRemedy,
  nextSteps,
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
