import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtureDir = fileURLToPath(
  new URL('../fixtures/state/', import.meta.url),
);
export const cases = ['active', 'divergent', 'none'] as const;
export type StateCase = (typeof cases)[number];

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-11-09T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-11-09T00:00:00Z',
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

// A deterministic repository (fixed author and dates, so its HEAD hash is the
// same on every run) holding one fixture case. `{{HEAD}}` in a capsule becomes
// that hash.
export function buildCaseRepo(name: StateCase): string {
  const root = mkdtempSync(join(tmpdir(), `krn-state-${name}-`));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.krn/\n');
  mkdirSync(join(root, 'tasks'));
  writeFileSync(
    join(root, 'tasks', 't-fixture1.json'),
    '{"id":"t-fixture1","status":"open"}\n',
  );
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'fixture');
  const head = git(root, 'rev-parse', 'HEAD');
  if (name !== 'none') {
    mkdirSync(join(root, '.krn', 'runs', 'lead', 'evidence'), {
      recursive: true,
    });
    mkdirSync(join(root, '.krn', 'runs', 'delivery-loop', 'main'), {
      recursive: true,
    });
    writeFileSync(
      join(root, '.krn', 'runs', 'delivery-loop', 'main', 'state.md'),
      readFileSync(join(fixtureDir, name, 'capsule.md'), 'utf8').replaceAll(
        '{{HEAD}}',
        head,
      ),
    );
  }
  return root;
}
