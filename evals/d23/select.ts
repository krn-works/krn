// Select D23 replay units: merged first-parent pull requests whose squash title carries a task id and (#n),
// whose diff changes at least one test/**/*.test.* file and at least one non-test source file.
// Usage: node evals/d23/select.ts [--ref origin/main] [--limit N] [--exclude <units file>] [--out <units.txt>]
// Prints one PR number per line, newest first; --out also writes them to a file.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Candidate {
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

export function parseLog(log: string): Candidate[] {
  const out: Candidate[] = [];
  for (const block of log.split('\u0001').slice(1)) {
    const [title = '', ...rest] = block.split('\n');
    const pr = /\(#(\d+)\)$/.exec(title.trim())?.[1];
    if (pr)
      out.push({ pr, title, files: rest.map((l) => l.trim()).filter(Boolean) });
  }
  return out;
}

export function select(
  candidates: Candidate[],
  opts: { limit?: number; exclude?: Set<string> },
): string[] {
  const picked = candidates
    .filter((c) => eligible(c) && !opts.exclude?.has(c.pr))
    .map((c) => c.pr);
  return opts.limit ? picked.slice(0, opts.limit) : picked;
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
  const prs = select(parseLog(log), {
    ...(limit ? { limit: Number(limit) } : {}),
    exclude,
  });
  const text = prs.map((p) => `${p}\n`).join('');
  const out = arg('out');
  if (out) writeFileSync(out, text);
  process.stdout.write(text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
