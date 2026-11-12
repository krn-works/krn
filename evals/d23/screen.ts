// Screen D23 units for derivability: can the hidden fail-to-pass tests be met from the task, interface and repository?
// Usage: node evals/d23/screen.ts --iface <dir> --out <dir> [--runs <d23-comparison dir>] [--grades <dir of <pr>.json or <pr>.classify.json>] [--units-file <file>] [--units 473,476] [--jobs 2] [--repo <git repository>] [--claude claude]
// Offline for the arms: writes <out>/<pr>.screen.json {class, reason, evidence}; arms never see it. Resumes from existing screen files.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DerivClass = 'D' | 'P' | 'N';
export interface Screen {
  class: DerivClass;
  reason: string;
  evidence: string;
}

export interface ScreenInput {
  task: string;
  iface: string;
  tests: { path: string; source: string }[];
  modules: { path: string; source: string }[];
}

const TEST_CAP = 12_000;
const MODULE_CAP = 8_000;

export const JUDGE_INSTRUCTIONS = `You judge whether a hidden acceptance test is derivable from what an engineer is given.
The engineer receives: the task text, an interface paragraph (module paths and exported names), and the repository as it was before the change. The engineer never sees the hidden tests. The tests must pass for a correct solution.

Classify the unit:
- D: every asserted literal and behavior follows from the task text, the interface paragraph or existing repository conventions.
- P: the behavior follows, but some exact literal is the original author's free choice that a careful engineer could plausibly match from conventions.
- N: an asserted literal or behavior is not stated or implied anywhere.

Calibration: judge each assertion against the sources, not against what a careless engineer might guess. A literal that existing repository code shows a convention for (error message shape, naming, exit code, file layout, how sibling modules do the same thing) is derivable, so the unit is D when the task also states the behavior and P when only the convention suggests the exact literal. Reserve N for an assertion that no source states or implies and that a careful engineer would have to invent: a specific output string, argument shape or file format that appears nowhere. One undetermined essential assertion makes the unit N; several incidental literals alone make it P.

Read the hidden tests, list what they assert (messages, names, exit codes, file formats, argument shapes), and check each against the task, interface and repository sources. Answer with one JSON object and nothing else:
{"class":"D|P|N","reason":"<one or two sentences>","evidence":"<the asserted literal or behavior that decides the class, and where it is or is not stated>"}`;

const cap = (text: string, n: number) =>
  text.length > n ? `${text.slice(0, n)}\n[truncated]` : text;

export function buildPrompt(input: ScreenInput): string {
  const parts = [
    JUDGE_INSTRUCTIONS,
    `## Task text\n${input.task}`,
    `## Interface paragraph\n${input.iface.trim() || '(none)'}`,
    ...input.modules.map(
      (m) =>
        `## Repository at the parent: ${m.path}\n${cap(m.source, MODULE_CAP)}`,
    ),
    ...input.tests.map(
      (t) => `## Hidden test: ${t.path}\n${cap(t.source, TEST_CAP)}`,
    ),
  ];
  return parts.join('\n\n');
}

/** Parse the judge's reply: a JSON object (possibly fenced) with a class D, P or N. */
export function parseReply(text: string): Screen {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('judge reply has no JSON');
  const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const cls = raw.class;
  if (cls !== 'D' && cls !== 'P' && cls !== 'N')
    throw new Error(`judge reply has no class D, P or N: ${String(cls)}`);
  return {
    class: cls,
    reason: String(raw.reason ?? ''),
    evidence: String(raw.evidence ?? ''),
  };
}

/** The `result` text of `claude -p --output-format json`. */
export function replyText(stdout: string): string {
  const env = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
  if (env.is_error || typeof env.result !== 'string')
    throw new Error('claude returned no result');
  return env.result;
}

function gitShow(repo: string, ref: string, path: string): string | undefined {
  const r = spawnSync('git', ['show', `${ref}:${path}`], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : undefined;
}

/** Task text as replay.sh builds it: the id comes from the merge's squash subject. */
export function taskText(repo: string, merge: string): string {
  const subject = spawnSync('git', ['log', '-1', '--format=%s', merge], {
    cwd: repo,
    encoding: 'utf8',
  }).stdout;
  const id = [...subject.matchAll(/t-[a-z0-9]{7}/g)].pop()?.[0];
  const raw = id && gitShow(repo, merge, `tasks/${id}.json`);
  if (!raw) throw new Error(`no task record for ${merge}`);
  const t = JSON.parse(raw) as { id: string; title: string; body: string[] };
  return `Task ${t.id}: ${t.title}\n\n${t.body.join('\n')}`;
}

export function interfaceModules(iface: string): string[] {
  const paths = [...iface.matchAll(/^- `([^`]+)` exports/gm)].map((m) => m[1]);
  return [...new Set(paths.filter((p): p is string => Boolean(p)))].filter(
    (p) => !/\.test\./.test(p),
  );
}

export interface UnitRef {
  pr: string;
  parent: string;
  merge: string;
  failToPass: string[];
}

export function gatherInput(
  repo: string,
  unit: UnitRef,
  iface: string,
): ScreenInput {
  return {
    task: taskText(repo, unit.merge),
    iface,
    tests: unit.failToPass.map((path) => ({
      path,
      source: gitShow(repo, unit.merge, path) ?? '(missing at merge)',
    })),
    modules: interfaceModules(iface).flatMap((path) => {
      const source = gitShow(repo, unit.parent, path);
      return source === undefined ? [] : [{ path, source }];
    }),
  };
}

export function runJudge(
  claude: string,
  prompt: string,
  cwd: string,
): Promise<string> {
  return new Promise((done, fail) => {
    const { NODE_TEST_CONTEXT: _n, ...env } = process.env;
    const child = spawn(
      claude,
      ['-p', '--model', 'claude-sonnet-5-5', '--output-format', 'json'],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('close', (code) =>
      code === 0
        ? done(out)
        : fail(new Error(`claude exited ${code}: ${err.slice(0, 500)}`)),
    );
    child.stdin.end(prompt);
  });
}

export async function screenUnit(
  repo: string,
  unit: UnitRef,
  iface: string,
  claude: string,
): Promise<Screen> {
  const prompt = buildPrompt(gatherInput(repo, unit, iface));
  return parseReply(replyText(await runJudge(claude, prompt, repo)));
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
      'usage: node evals/d23/screen.ts --iface <dir> --out <dir> [--runs <dir>] [--grades <dir>] [--units-file <file>] [--units 473,476] [--jobs 2] [--repo <git repository>] [--claude claude]',
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
    Array.from({ length: Number(arg('jobs', '2')) }, async () => {
      for (let pr = queue.shift(); pr; pr = queue.shift()) {
        const file = join(out, `${pr}.screen.json`);
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
          const screen = await screenUnit(repo, unit, iface, claude);
          writeFileSync(file, `${JSON.stringify(screen, null, 2)}\n`);
          console.log(`${pr} ${screen.class}`);
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
