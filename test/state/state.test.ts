import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCaseRepo, cases, fixtureDir } from './fixture-repo.ts';

// KRN-12: the captures under test/fixtures/state are the verbatim stdout,
// stderr and exit code of the legacy release (state check|resume --root) on the
// same deterministic repositories; only the temp root is replaced by <root>.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const capture = (name: string, file: string) =>
  readFileSync(join(fixtureDir, name, file), 'utf8');

for (const name of cases) {
  for (const verb of ['check', 'resume']) {
    test(`state ${verb} matches the legacy capture for the ${name} capsule without HOME or KRN_STATE_ENTRY`, () => {
      const home = mkdtempSync(join(tmpdir(), 'krn-state-home-'));
      const root = realpathSync(buildCaseRepo(name));
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete env.KRN_STATE_ENTRY;
        const result = spawnSync(
          process.execPath,
          [cli, 'state', verb, '--root', root],
          { encoding: 'utf8', env },
        );
        const unroot = (text: string) => text.replaceAll(root, '<root>');
        assert.equal(
          unroot(result.stdout),
          capture(name, `${verb}.stdout.txt`),
        );
        assert.equal(
          unroot(result.stderr),
          capture(name, `${verb}.stderr.txt`),
        );
        assert.equal(`${result.status}\n`, capture(name, `${verb}.exit.txt`));
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
}

test('state refuses an unknown verb or a second root with exit 64 and no stdout', () => {
  for (const args of [
    ['state', 'bogus'],
    ['state', 'check', '.', '--root', '.'],
    ['state', 'check', '--root'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 64, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
  }
});

test('state check on a missing path exits 64 naming the path', () => {
  const result = spawnSync(
    process.execPath,
    [cli, 'state', 'check', '--root', join(tmpdir(), 'krn-state-absent')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 64);
  assert.match(result.stderr, /does not exist/);
});

test('state check warns when an operator ask names another repository and passes for this one', () => {
  const warningsFor = (unknowns: string) => {
    const root = realpathSync(buildCaseRepo('active'));
    try {
      const file = join(root, '.krn/runs/delivery-loop/main/state.md');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          'Open unknowns and blockers with owners: none',
          `Open unknowns and blockers with owners: ${unknowns}`,
        ),
      );
      const out = spawnSync(
        process.execPath,
        [cli, 'state', 'check', '--root', root],
        { encoding: 'utf8' },
      ).stdout;
      return (JSON.parse(out) as { warnings: { rule: string }[] }).warnings.map(
        (w) => w.rule,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const rule = 'operator-ask-other-repository';
  assert.ok(
    warningsFor('operator: merge design-studio#12 and restart').includes(rule),
  );
  assert.ok(
    warningsFor('operator: run /srv/ekologus-wp-local/deploy.sh').includes(
      rule,
    ),
  );
  assert.ok(
    !warningsFor(
      'operator: install krn-codex-skills release containing #482; owner: krn-codex-skills#476 conflicts',
    ).includes(rule),
  );
  assert.ok(!warningsFor('none').includes(rule));
});
