// Freeze the FR-40 experiment: write tasks.json (every convention task),
// material.json (arm B brain packet and arm S static standards per task) and
// manifest.json (arms, fixed strata, scorer argv, D20 thresholds, input hashes).
// `--check` regenerates in memory and exits 1 when a committed file drifted.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fr40Packet } from '../../src/brain/cli.ts';
import { generate } from './tasks.ts';

const here = new URL('./', import.meta.url);

/** Hashed beside the generated files: the scorer, its task source and the arm material sources. */
const SOURCES = [
  'scorers.ts',
  'tasks.ts',
  'records.json',
  'standards.md',
  'validity.json',
  'convention-power.json',
];

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

export function freeze(): Record<string, string> {
  const tasks = generate();
  const files: Record<string, string> = {
    'tasks.json': json(tasks),
    'material.json': json(
      Object.fromEntries(
        tasks.map((task) => [
          task.id,
          {
            packet: fr40Packet(task.id, 'brain').text,
            standards: fr40Packet(task.id, 'static').text,
          },
        ]),
      ),
    ),
  };
  const inputs: Record<string, string> = {};
  for (const path of [...SOURCES, ...Object.keys(files)].sort())
    inputs[path] = sha256(
      files[path] ?? readFileSync(new URL(path, here), 'utf8'),
    );
  files['manifest.json'] = json({
    id: 'fr40',
    design: 'fr40',
    frozen: true,
    seed: 'fr40-2026-11-08',
    replicas: 1,
    arms: [
      { id: 'A', model: 'gpt-6-luna', harness: 'codex', material: 'none' },
      { id: 'B', model: 'gpt-6-luna', harness: 'codex', material: 'packet' },
      { id: 'S', model: 'gpt-6-luna', harness: 'codex', material: 'standards' },
    ],
    tasks: tasks.map((task) => ({ id: task.id, stratum: task.template })),
    taskFile: 'tasks.json',
    material: 'material.json',
    check: [
      'node',
      '{experiment}/scorers.ts',
      '{experiment}/tasks.json',
      '{repo}',
      '--task',
      '{task}',
    ],
    analysis: {
      alpha: 0.05,
      level: 0.9,
      goPacket: 0.15,
      goRetrieval: 0.1,
      killUpper: 0.1,
      tokenRatio: 1.25,
      stopAfter: 20,
    },
    inputs,
  });
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let drift = 0;
  for (const [path, content] of Object.entries(freeze())) {
    const target = new URL(path, here);
    if (!check) writeFileSync(target, content);
    else {
      let current = '';
      try {
        current = readFileSync(target, 'utf8');
      } catch {}
      if (current !== content) {
        process.stderr.write(`drift: evals/fr40/${path}\n`);
        drift += 1;
      }
    }
  }
  process.stdout.write(check ? `drift=${drift}\n` : 'frozen\n');
  process.exit(drift === 0 ? 0 : 1);
}
