import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Sends a slice's friction log (blockers, refusals, workarounds with evidence paths) to
// GPT-6.2 Astra through `codex exec` in a read-only sandbox and writes its critique under
// .krn/runs/research/gpt-6-2/. Codex runs on the ChatGPT login: API-key variables are
// removed from its environment so a run never bills an API key.
export const model = 'gpt-6.2-astra';
export const defaultLog = '.krn/tmp/friction.md';
const instruction = [
  'You critique one delivery slice. Below is its friction log: blockers, tool refusals and workarounds, each with evidence paths.',
  'For every entry name the root defect (not the workaround), the smallest repository change that removes it for good (a check, a rule or a task), and say when the entry is no defect.',
  'Answer as a numbered list, one finding per entry, at most ten lines each. Do not edit anything.',
].join('\n');

export type Plan = {
  command: string[];
  prompt: string;
  out: string;
  log: string;
  missing: boolean;
};

export function plan(
  root: string,
  options: { log?: string; out?: string; date?: string },
): Plan {
  const log = resolve(root, options.log ?? defaultLog);
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const out = resolve(
    root,
    options.out ?? `.krn/runs/research/gpt-6-2/critique-${date}.md`,
  );
  const missing = !existsSync(log) || !statSync(log).isFile();
  const friction = missing ? '' : readFileSync(log, 'utf8').trim();
  return {
    command: [
      'codex',
      'exec',
      '-m',
      model,
      '-c',
      'model_reasoning_effort=high',
      '-s',
      'read-only',
      '-C',
      root,
      '-o',
      out,
      '-',
    ],
    prompt: `${instruction}\n\n--- friction log (${log}) ---\n${friction}\n`,
    out,
    log,
    missing,
  };
}

export function subscriptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY']) delete clean[key];
  return clean;
}

export function run(
  argv: string[],
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const options: { log?: string; out?: string; date?: string } = {};
  let dry = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const key = arg.slice(2) as 'log' | 'out' | 'date';
    if (arg === '--dry-run') dry = true;
    else if (['--log', '--out', '--date'].includes(arg) && argv[i + 1]) {
      i += 1;
      options[key] = argv[i];
    } else {
      process.stderr.write(
        `astra-critique: unknown argument ${arg}\nusage: astra-critique.ts [--log <friction file>] [--out <critique file>] [--date <YYYY-MM-DD>] [--dry-run]\n`,
      );
      return 64;
    }
  }
  const p = plan(root, options);
  if (dry) {
    process.stdout.write(
      `${p.command.join(' ')} < prompt\n${p.missing ? `friction log ${p.log} is missing\n` : ''}${p.prompt}`,
    );
    return 0;
  }
  if (p.missing || p.prompt.endsWith('---\n\n')) {
    process.stderr.write(
      `astra-critique: friction log ${p.log} is missing or empty; write the slice's blockers, refusals and workarounds there first\n`,
    );
    return 66;
  }
  mkdirSync(dirname(p.out), { recursive: true });
  const [bin, ...args] = p.command as [string, ...string[]];
  const result = spawnSync(bin, args, {
    input: p.prompt,
    env: subscriptionEnv(env),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.status !== 0) return result.status ?? 1;
  if (!existsSync(p.out) || statSync(p.out).size === 0) {
    process.stderr.write(`astra-critique: ${p.out} is empty after the run\n`);
    return 1;
  }
  process.stdout.write(`${p.out}\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = run(process.argv.slice(2), process.cwd());
