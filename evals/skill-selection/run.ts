// Live skill-selection eval. Not part of npm test: it spends model budget.
// Usage: node evals/skill-selection/run.ts [--model claude-haiku-5-5] [--runs 3] [--budget 0.15] [--out report.json]
import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Choice, chosenSkill, firstToolCall, totalCost } from './parse.ts';
import prompts from './prompts.json' with { type: 'json' };

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const model = arg('model', 'claude-haiku-5-5');
const budget = arg('budget', '0.15');
const runs = Number(arg('runs', '1'));
const out = arg('out', '');
const repo = fileURLToPath(new URL('../..', import.meta.url));

// Only the Skill tool is enabled and one turn is allowed, so the first tool call is the selection
// and nothing else can run.
// A scratch project holding only the repo skills: no hooks, no settings, no state.
const sandbox = mkdtempSync(
  join(process.env.KRN_EVAL_TMP ?? tmpdir(), 'skill-selection-'),
);
cpSync(join(repo, '.agents'), join(sandbox, '.agents'), { recursive: true });
mkdirSync(join(sandbox, '.claude'));
symlinkSync('../.agents/skills', join(sandbox, '.claude/skills'));

function trial(
  prompt: string,
): Promise<{ choice: Choice | undefined; cost: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--model',
        model,
        '--output-format',
        'stream-json',
        '--verbose',
        '--max-budget-usd',
        budget,
        '--setting-sources',
        'project',
        '--no-session-persistence',
        '--tools',
        'Skill',
        '--max-turns',
        '1',
        prompt,
      ],
      { cwd: sandbox, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let choice: Choice | undefined;
    let cost = 0;
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        choice ??= firstToolCall(line);
        cost = totalCost(line) ?? cost;
      }
    });
    child.on('close', () => resolve({ choice, cost }));
  });
}

const rows = [];
for (const { id, prompt, expect } of prompts) {
  const got: (string | null)[] = [];
  let cost = 0;
  for (let run = 0; run < runs; run += 1) {
    const result = await trial(prompt);
    got.push(chosenSkill(result.choice));
    cost += result.cost;
  }
  const hits = got.filter((name) => name === expect).length;
  rows.push({ id, expect, got, hits, runs, cost });
  console.log(
    `${hits === runs ? 'ok  ' : 'MISS'} ${id}: expected ${expect}, got ${got.join(',')}`,
  );
}
rmSync(sandbox, { recursive: true, force: true });
const hits = rows.reduce((sum, row) => sum + row.hits, 0);
const total = rows.length * runs;
const cost = rows.reduce((sum, row) => sum + row.cost, 0);
console.log(`hit rate ${hits}/${total} on ${model}, cost $${cost.toFixed(3)}`);
if (out)
  writeFileSync(
    out,
    `${JSON.stringify({ model, hits, total, cost, rows }, null, 2)}\n`,
  );
