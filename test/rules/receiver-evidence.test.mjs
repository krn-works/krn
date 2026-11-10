import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: every module that spawns a receiver names its evidence in
// spec/receivers.json: a verbatim capture read by a named test, a named test
// that drives the real receiver, or `pending: <open task>` until it has one.
const root = fileURLToPath(new URL('../..', import.meta.url));
const spawnImport = /['"](?:node:)?child_process['"]/u;

function receiverModules(base) {
  return readdirSync(join(base, 'src'), { recursive: true })
    .map((file) => `src/${String(file).replaceAll('\\', '/')}`)
    .filter(
      (file) =>
        file.endsWith('.ts') &&
        spawnImport.test(readFileSync(join(base, file), 'utf8')),
    )
    .sort();
}

function openTask(base, id) {
  const file = join(base, 'tasks', `${id}.json`);
  return (
    existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).status === 'open'
  );
}

export function receiverProblems(base) {
  const { modules } = JSON.parse(
    readFileSync(join(base, 'spec/receivers.json'), 'utf8'),
  );
  const problems = [];
  for (const module of receiverModules(base))
    if (!Object.hasOwn(modules, module))
      problems.push(
        `${module} spawns a receiver but is not in spec/receivers.json`,
      );
  for (const [module, entry] of Object.entries(modules)) {
    const at = `spec/receivers.json ${module}`;
    if (!existsSync(join(base, module))) problems.push(`${at}: module missing`);
    if (!Array.isArray(entry.receivers) || entry.receivers.length === 0)
      problems.push(`${at}: name its receivers`);
    const kinds = ['real', 'capture', 'pending'].filter((key) => key in entry);
    if (kinds.length !== 1) {
      problems.push(`${at}: needs exactly one of real, capture, pending`);
      continue;
    }
    if (entry.pending !== undefined) {
      if (!openTask(base, entry.pending))
        problems.push(`${at}: pending ${entry.pending} is not an open task`);
      continue;
    }
    const testFile = entry.real ?? entry.test;
    if (
      typeof testFile !== 'string' ||
      !/\.test\.[cm]?[jt]s$/u.test(testFile)
    ) {
      problems.push(`${at}: name a test file`);
      continue;
    }
    if (!existsSync(join(base, testFile))) {
      problems.push(`${at}: test ${testFile} missing`);
      continue;
    }
    if (entry.capture === undefined) continue;
    const source = readFileSync(join(base, testFile), 'utf8');
    if (!Array.isArray(entry.capture) || entry.capture.length === 0)
      problems.push(`${at}: list its capture files`);
    for (const capture of entry.capture ?? []) {
      if (
        !capture.startsWith('test/fixtures/') ||
        !existsSync(join(base, capture))
      )
        problems.push(`${at}: capture ${capture} missing under test/fixtures`);
      const stem = basename(capture, extname(capture));
      const directory = `fixtures/${basename(dirname(capture))}`;
      if (!source.includes(stem) && !source.includes(directory))
        problems.push(`${at}: ${testFile} does not read ${capture}`);
    }
  }
  return problems;
}

function copy() {
  const base = mkdtempSync(join(tmpdir(), 'krn-receivers-'));
  for (const directory of ['src', 'spec', 'test', 'tasks'])
    cpSync(join(root, directory), join(base, directory), { recursive: true });
  return base;
}

test('receiver modules name their evidence', () => {
  assert.deepEqual(receiverProblems(root), []);
});

test('receiver evidence fails for an unregistered host module and a deleted capture', (t) => {
  const base = copy();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(
    join(base, 'src/cli/new-receiver.ts'),
    "import { spawnSync } from 'node:child_process';\nexport const run = () => spawnSync('herdr');\n",
  );
  rmSync(join(base, 'test/fixtures/github-check-runs/gate-success.json'));
  assert.deepEqual(receiverProblems(base), [
    'src/cli/new-receiver.ts spawns a receiver but is not in spec/receivers.json',
    'spec/receivers.json src/deliver/gate-wait.ts: capture test/fixtures/github-check-runs/gate-success.json missing under test/fixtures',
  ]);
});
