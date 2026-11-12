// Write the observable behaviour a D23 unit's hidden fail-to-pass tests check, as requirements.
// Usage: node evals/d23/requirements.ts --iface <dir> --out <dir> [--runs <d23-comparison dir>] [--grades <dir>] [--units-file <file>] [--units 473,476] [--jobs 8] [--repo <git repository>] [--claude claude]
// Offline for the arms: writes <out>/<pr>.requirements.txt; resumes from existing files.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gatherInput,
  replyText,
  runJudge,
  type ScreenInput,
  type UnitRef,
} from './screen.ts';

const TEST_CAP = 14_000;
const MODULE_CAP = 6_000;
const LEAK_MIN_CHARS = 25;

export const REQUIREMENTS_INSTRUCTIONS = `You write the requirements section of a task for an engineer who will implement a change.
You are given the task text, an interface paragraph, the repository before the change, and the acceptance tests the change must pass. The engineer never sees the tests.

Write the observable behaviour those tests check, so that an engineer who reads only your text can satisfy them. Cover every one of: command-line flags and argument shapes, exact output lines and error messages (stdout versus stderr), exit codes, file names, paths and file formats, JSON field names and shapes, function names, parameters and return shapes, and the order or conditions under which things happen.

Rules:
- Write requirements ("the command prints ... and exits 78 when ..."), as short bullet lines. Give every literal a test depends on verbatim and in backticks, as a value the behaviour must produce.
- Never quote or paraphrase test code: no assert calls, no fixtures, no test names, no setup lines. State the behaviour, not how the test checks it.
- Never describe how to implement it: no internal algorithms, helper names or code structure beyond the public interface the tests call.
- Do not repeat what the task text or interface paragraph already says exactly; add what they leave open.
- The engineer does not know tests exist: never mention tests, fixtures or how anything is checked; phrase every line as a property of the finished product.
- Write in English. Plain text only, no preamble, at most 40 lines.`;

const cap = (text: string, n: number) =>
  text.length > n ? `${text.slice(0, n)}\n[truncated]` : text;

export function buildRequirementsPrompt(input: ScreenInput): string {
  return [
    REQUIREMENTS_INSTRUCTIONS,
    `## Task text\n${input.task}`,
    `## Interface paragraph\n${input.iface.trim() || '(none)'}`,
    ...input.modules.map(
      (m) =>
        `## Repository before the change: ${m.path}\n${cap(m.source, MODULE_CAP)}`,
    ),
    ...input.tests.map(
      (t) => `## Acceptance test: ${t.path}\n${cap(t.source, TEST_CAP)}`,
    ),
  ].join('\n\n');
}

const normalize = (line: string) => line.trim().replace(/\s+/g, ' ');

/** Test-body lines that the requirements text copies verbatim (long lines only; short literals are the point). */
export function leakedLines(
  requirements: string,
  tests: { source: string }[],
): string[] {
  const text = normalize(requirements);
  const leaked = new Set<string>();
  for (const t of tests)
    for (const raw of t.source.split('\n')) {
      const line = normalize(raw);
      if (line.length >= LEAK_MIN_CHARS && text.includes(line))
        leaked.add(line);
    }
  return [...leaked];
}

/** Strip a code fence the model may wrap its answer in. */
export function cleanRequirements(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z]*\n/, '')
    .replace(/\n```$/, '')
    .trim();
}

/** Why a reply is not usable requirements text, or undefined: it must open with a bullet and be English. */
export function requirementsProblem(text: string): string | undefined {
  if (!/^[-*] /.test(text)) return 'does not open with a bullet line';
  if (/[ąćęłńóśźż]/i.test(text)) return 'is not written in English';
  return undefined;
}

export async function requirementsForUnit(
  repo: string,
  unit: UnitRef,
  iface: string,
  claude: string,
): Promise<string> {
  const input = gatherInput(repo, unit, iface);
  const prompt = buildRequirementsPrompt(input);
  // An empty working directory: the writer sees only the prompt, not the current checkout.
  const cwd = mkdtempSync(join(tmpdir(), 'd23-requirements-'));
  let leaks: string[] = [];
  let problem: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const extra = leaks.length
      ? `\n\nYour previous answer copied these test lines verbatim; do not copy any test line:\n${leaks.map((l) => `- ${l}`).join('\n')}`
      : problem
        ? `\n\nYour previous answer ${problem}. Answer with English bullet lines only, starting with "- ".`
        : '';
    const text = cleanRequirements(
      replyText(await runJudge(claude, prompt + extra, cwd)),
    );
    leaks = leakedLines(text, input.tests);
    problem = requirementsProblem(text);
    if (!leaks.length && !problem) return text;
  }
  throw new Error(
    leaks.length
      ? `requirements leak test lines: ${leaks[0]}`
      : `requirements ${problem}`,
  );
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const mainRoot = repoRoot.split('/.krn/worktrees/')[0] ?? repoRoot;

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return (i > 0 ? process.argv[i + 1] : undefined) ?? fallback;
};

async function main() {
  const runs = resolve(arg('runs', join(mainRoot, '.krn/runs/d23-comparison')));
  const grades = resolve(arg('grades', join(runs, 'regrade')));
  const ifaceDir = arg('iface', '');
  const outArg = arg('out', '');
  if (!ifaceDir || !outArg) {
    console.error(
      'usage: node evals/d23/requirements.ts --iface <dir> --out <dir> [--runs <dir>] [--grades <dir>] [--units-file <file>] [--units 473,476] [--jobs 8] [--repo <git repository>] [--claude claude]',
    );
    process.exit(64);
  }
  const out = resolve(outArg);
  const only = arg('units', '');
  const units = readFileSync(
    resolve(arg('units-file', join(runs, 'units.txt'))),
    'utf8',
  )
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((u) => u && (!only || only.split(',').includes(u)));
  mkdirSync(out, { recursive: true });
  const claude = arg('claude', 'claude');
  const repo = resolve(arg('repo', repoRoot));
  const queue = [...units];
  let failed = 0;
  await Promise.all(
    Array.from({ length: Number(arg('jobs', '8')) }, async () => {
      for (let pr = queue.shift(); pr; pr = queue.shift()) {
        const file = join(out, `${pr}.requirements.txt`);
        if (existsSync(file)) continue;
        try {
          const gradeFile = [`${pr}.json`, `${pr}.classify.json`]
            .map((f) => join(grades, f))
            .find(existsSync);
          if (!gradeFile)
            throw new Error(`no grade or classify json for ${pr}`);
          const unit = JSON.parse(readFileSync(gradeFile, 'utf8')) as UnitRef;
          const ifaceFile = join(resolve(ifaceDir), `${pr}.txt`);
          const iface = existsSync(ifaceFile)
            ? readFileSync(ifaceFile, 'utf8')
            : '';
          const text = await requirementsForUnit(repo, unit, iface, claude);
          writeFileSync(file, `${text}\n`);
          console.log(`${pr} ok`);
        } catch (e) {
          failed++;
          console.error(`${pr} failed: ${(e as Error).message}`);
        }
      }
    }),
  );
  if (failed) process.exit(1);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
