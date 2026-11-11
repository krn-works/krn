// Freeze the FR-40 experiment: write tasks.json (every convention task),
// material.json (arm B brain packet and arm S static standards per task) and
// scorer-imports.json (hashes of files the scorer imports from outside evals/fr40)
// and manifest.json (arms, fixed strata, scorer argv, D20 thresholds, input hashes).
// `--check` regenerates in memory and exits 1 when a committed file drifted;
// `--write` rewrites the committed files; any other argument exits 64 and writes nothing.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fr40Packet } from '../../src/brain/cli.ts';
import { generate } from './tasks.ts';

const here = new URL('./', import.meta.url);

const dir = fileURLToPath(here);
const repo = resolve(dir, '../..');

/** Local imports of the given entries, transitively, as absolute paths. */
export function importClosure(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const [, specifier] of text.matchAll(
      /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/gu,
    ))
      visit(resolve(dirname(file), specifier as string));
  };
  for (const entry of entries) visit(resolve(dir, entry));
  return [...seen];
}

const SCORER = ['scorers.ts', 'tasks.ts'];

/**
 * Hashed beside the generated files: the scorer, its task source and the arm
 * material sources. Manifest inputs stay inside the experiment, so files the
 * scorer imports from elsewhere (scripts/boundaries.ts decides core-imports)
 * are hashed into the generated scorer-imports.json.
 */
const SOURCES = [
  ...SCORER,
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
    'scorer-imports.json': json(
      Object.fromEntries(
        importClosure(SCORER)
          .filter((file) => !file.startsWith(dir))
          .map((file) => [
            relative(repo, file),
            sha256(readFileSync(file, 'utf8')),
          ])
          .sort(([a], [b]) => (a as string).localeCompare(b as string)),
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
      '{base}',
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
  const args = process.argv.slice(2);
  const mode = args.length === 1 ? args[0] : undefined;
  if (mode !== '--check' && mode !== '--write') {
    process.stderr.write(
      `unknown argument: ${args.join(' ') || '(none)'}\nusage: node evals/fr40/freeze.ts --check | --write\n`,
    );
    process.exit(64);
  }
  const check = mode === '--check';
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
