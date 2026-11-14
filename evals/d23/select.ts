// Select D23 replay units: merged first-parent pull requests whose squash title carries a task id and (#n),
// whose diff changes at least one test/**/*.test.* file and at least one non-test source file,
// and whose task no earlier first-parent commit names: the replay prompts with the task body, which a
// follow-up PR's parent already delivers (D23 units 467 and 586 ended with a correct "already done").
// A unit whose parent already fails the tests its change selects (red K baseline) is dropped for every arm
// (--no-baseline-check skips that run); stderr prints the count of excluded units.
// Usage: node evals/d23/select.ts [--ref origin/main] [--limit N] [--exclude <units file>] [--out <units.txt>]
// Prints one PR number per line, newest first; --out also writes them to a file.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { redAtParent } from './baseline.ts';

export interface Candidate {
  /** Empty for a first-parent commit without a (#n) suffix; it still names a task. */
  pr: string;
  title: string;
  files: string[];
}

const isTest = (f: string) => /^test\/.*\.test\.[a-z]+$/.test(f);
// Tracker records and the test tree's fixtures are not source changes.
const isSource = (f: string) =>
  !f.startsWith('test/') && !f.startsWith('tasks/');

export function eligible(c: Candidate): boolean {
  return (
    /\bt-[a-z0-9]{7}\b/.test(c.title) &&
    c.files.some(isTest) &&
    c.files.some(isSource)
  );
}

// The replay reads the last task id of the title, so this does too.
export function taskOf(title: string): string | undefined {
  return title.match(/\bt-[a-z0-9]{7}\b/g)?.at(-1);
}

export function parseLog(log: string): Candidate[] {
  const out: Candidate[] = [];
  for (const block of log.split('\u0001').slice(1)) {
    const [title = '', ...rest] = block.split('\n');
    const pr = /\(#(\d+)\)$/.exec(title.trim())?.[1] ?? '';
    out.push({ pr, title, files: rest.map((l) => l.trim()).filter(Boolean) });
  }
  return out;
}

// Candidates come newest first; a task named by any older commit was already under way at the parent.
function firstDeliveries(candidates: Candidate[]): Set<Candidate> {
  const seen = new Set<string>();
  const first = new Set<Candidate>();
  for (const c of [...candidates].reverse()) {
    const task = taskOf(c.title);
    if (!task) continue;
    if (!seen.has(task)) first.add(c);
    seen.add(task);
  }
  return first;
}

export interface Selection {
  units: string[];
  /** Eligible units dropped because their K baseline is red; they are excluded for every arm. */
  redBaseline: string[];
}

export function selectUnits(
  candidates: Candidate[],
  opts: {
    limit?: number;
    exclude?: Set<string>;
    /** True when the unit's parent already fails the tests its change selects. */
    redBaseline?: (pr: string) => boolean;
  },
): Selection {
  const first = firstDeliveries(candidates);
  const units: string[] = [];
  const redBaseline: string[] = [];
  for (const c of candidates) {
    if (opts.limit && units.length >= opts.limit) break;
    if (c.pr === '' || !first.has(c) || !eligible(c)) continue;
    if (opts.exclude?.has(c.pr)) continue;
    if (opts.redBaseline?.(c.pr)) redBaseline.push(c.pr);
    else units.push(c.pr);
  }
  return { units, redBaseline };
}

export function select(
  candidates: Candidate[],
  opts: { limit?: number; exclude?: Set<string> },
): string[] {
  return selectUnits(candidates, opts).units;
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function main() {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const log = execFileSync(
    'git',
    [
      'log',
      '--first-parent',
      '--name-only',
      '--format=%x01%s',
      arg('ref') ?? 'origin/main',
    ],
    { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  const excludeFile = arg('exclude');
  if (excludeFile && !existsSync(excludeFile))
    throw new Error(`--exclude file not found: ${excludeFile}`);
  const exclude = new Set(
    excludeFile
      ? readFileSync(excludeFile, 'utf8')
          .split('\n')
          .map((l) => l.trim().split(/\s+/)[0] ?? '')
          .filter(Boolean)
      : [],
  );
  const limit = arg('limit');
  const merged = execFileSync(
    'git',
    ['log', '--first-parent', '--format=%H %s', arg('ref') ?? 'origin/main'],
    { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 },
  ).split('\n');
  const redBaseline = (pr: string) => {
    const sha = merged.find((l) => l.endsWith(`(#${pr})`))?.split(' ')[0];
    if (!sha) return false;
    return redAtParent(repo, `${sha}^`, sha);
  };
  const { units, redBaseline: red } = selectUnits(parseLog(log), {
    ...(limit ? { limit: Number(limit) } : {}),
    exclude,
    ...(process.argv.includes('--no-baseline-check') ? {} : { redBaseline }),
  });
  const text = units.map((p) => `${p}\n`).join('');
  const out = arg('out');
  if (out) writeFileSync(out, text);
  process.stdout.write(text);
  process.stderr.write(
    `excluded ${red.length} red-baseline units${red.length ? `: ${red.join(' ')}` : ''}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
