// Freeze the FR-40 experiment: write tasks.json (every convention task),
// material.json (arm B brain packet and arm S static standards per task) and
// scorer-imports.json (what the scorer's core-imports check returns on a fixed fixture tree)
// and manifest.json (arms, fixed strata, scorer argv, D20 thresholds, input hashes).
// `--check` regenerates in memory and exits 1 when a committed file drifted;
// `--write` rewrites the committed files; any other argument exits 64 and writes nothing.
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../../scripts/boundaries.ts';
import { fr40Packet } from './packets.ts';
import { generate } from './tasks.ts';

const here = new URL('./', import.meta.url);

/**
 * The core-imports scorer asks scripts/boundaries.ts for violations under src/core, so the
 * experiment depends on that verdict, not on the file's bytes: this runs the same call on a
 * fixed tree, and an edit to any other layer leaves the frozen record unchanged.
 */
export function coreImportVerdicts(): unknown {
  const fixture = mkdtempSync(join(tmpdir(), 'fr40-core-imports-'));
  try {
    const files: Record<string, string> = {
      'src/core/own.ts':
        "import './nested/deep.ts';\nexport * from './sibling.ts';\n",
      'src/core/sibling.ts': 'export const sibling = 1;\n',
      'src/core/nested/deep.ts':
        "import '../sibling.ts';\nimport '../../cli/adapter.ts';\n",
      'src/core/dynamic.ts':
        "export const load = () => import('../brain/adapter.ts');\n",
      'src/core/reexport.ts': "export { adapter } from '../ci/adapter.ts';\n",
      'src/core/builtin.ts': "import 'node:fs';\n",
      'src/core/commented.ts': "// import '../cli/adapter.ts';\n",
      'src/core/top-level.ts': "import '../../core/outside.ts';\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      writeFileSync(join(fixture, path), text);
    }
    return check(fixture)
      .filter((violation) => violation.file.startsWith('src/core/'))
      .map(({ file, line, specifier }) => ({ file, line, specifier }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const SCORER = ['scorers.ts', 'tasks.ts'];

/**
 * Hashed beside the generated files: the scorer, its task source and the arm
 * material sources. Manifest inputs stay inside the experiment, so the one outside
 * behaviour the scorer uses (scripts/boundaries.ts decides core-imports) is recorded as
 * its verdicts on a fixed tree in the generated scorer-imports.json.
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
    'scorer-imports.json': json({
      'src/core violations on a fixed tree': coreImportVerdicts(),
    }),
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
