import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adoptionDrift } from '../../src/adopt/drift.ts';
import {
  SITE_SKILLS_DIR,
  siteSkillNames,
  skillSet,
} from '../../src/adopt/skill-set.ts';

const everything = [
  'delivery-lead',
  'delivery-handoff',
  'delivery-retro',
  'python',
  'php',
  'typescript',
  'go',
  ...[
    'acf-component',
    'cube-css',
    'cube-review',
    'design-to-build',
    'plesk-deploy',
    'wp-runtime',
  ],
];

function withRoot(marker: string, check: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'skill-set-'));
  try {
    writeFileSync(join(root, marker), '');
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a language stack gets the core skills only, never a per-language prose skill', () => {
  for (const marker of [
    'pyproject.toml',
    'composer.json',
    'Cargo.toml',
    'go.mod',
    'package.json',
  ])
    withRoot(marker, (root) =>
      assert.deepEqual(
        skillSet(root, everything),
        ['delivery-lead', 'delivery-handoff', 'delivery-retro'],
        marker,
      ),
    );
});

const frontendSkills = ['cube-css', 'cube-review', 'design-to-build'];
const wordpressSkills = [...frontendSkills, 'acf-component', 'wp-runtime'];
const core = ['delivery-lead', 'delivery-handoff', 'delivery-retro'];

test('a WordPress repository gets the core skills plus the boilerplate skills, limited to what exists', () => {
  withRoot('wp-config.php', (root) => {
    assert.deepEqual(
      skillSet(root, everything).sort(),
      [...core, ...wordpressSkills].sort(),
    );
    assert.deepEqual(skillSet(root, ['delivery-lead']), ['delivery-lead']);
  });
});

test('a frontend repository gets the core skills plus the CSS and design skills', () => {
  withRoot('index.html', (root) =>
    assert.deepEqual(
      skillSet(root, everything).sort(),
      [...core, ...frontendSkills].sort(),
    ),
  );
});

test('plesk-deploy is installed only where a workflow deploys to Plesk', () => {
  withRoot('wp-config.php', (root) => {
    assert.equal(skillSet(root, everything).includes('plesk-deploy'), false);
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    assert.equal(skillSet(root, everything).includes('plesk-deploy'), false);
    writeFileSync(
      join(root, '.github', 'workflows', 'deploy.yml'),
      '# release to the Plesk server\n',
    );
    assert.equal(skillSet(root, everything).includes('plesk-deploy'), true);
  });
  withRoot('Cargo.toml', (root) => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'd.yml'), 'plesk\n');
    assert.equal(skillSet(root, everything).includes('plesk-deploy'), false);
  });
});

const boilerplate =
  process.env.KRN_BOILERPLATE_REPO ??
  fileURLToPath(new URL('../../../boilerplate-2026', import.meta.url));
const pin = JSON.parse(
  readFileSync(join(SITE_SKILLS_DIR, 'source.json'), 'utf8'),
) as { commit: string };

function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? filesUnder(dir, join(prefix, e.name))
      : [join(prefix, e.name)],
  );
}

test('the site skills are the boilerplate files of the pinned commit, whole, with no hand edit', () => {
  assert.match(pin.commit, /^[0-9a-f]{40}$/u);
  assert.deepEqual(siteSkillNames(), [
    'acf-component',
    'cube-css',
    'cube-review',
    'design-to-build',
    'plesk-deploy',
    'wp-runtime',
  ]);
  const have = spawnSync('git', [
    '-C',
    boilerplate,
    'cat-file',
    '-e',
    pin.commit,
  ]);
  if (have.status !== 0) return; // the source checkout exists only on hosts that keep boilerplate-2026
  const listed = spawnSync(
    'git',
    [
      '-C',
      boilerplate,
      'ls-tree',
      '-r',
      '--name-only',
      pin.commit,
      '.agents/skills/',
    ],
    { encoding: 'utf8' },
  )
    .stdout.split('\n')
    .filter((f) => f !== '')
    .map((f) => f.replace('.agents/skills/', ''))
    .sort();
  const held = siteSkillNames().flatMap((n) =>
    filesUnder(join(SITE_SKILLS_DIR, n)).map((f) => join(n, f)),
  );
  assert.deepEqual(held.sort(), listed);
  for (const file of listed) {
    const source = spawnSync(
      'git',
      ['-C', boilerplate, 'show', `${pin.commit}:.agents/skills/${file}`],
      { encoding: 'utf8' },
    ).stdout;
    assert.equal(
      readFileSync(join(SITE_SKILLS_DIR, file), 'utf8'),
      source,
      file,
    );
  }
});

test('every site skill passes the skill-creator checks: kebab name equal to its directory, a description, allowed fields', () => {
  for (const name of siteSkillNames()) {
    const text = readFileSync(join(SITE_SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    const head = /^---\n(.*?)\n---/su.exec(text)?.[1] ?? '';
    const fields = [...head.matchAll(/^([a-z-]+):/gmu)].map((m) => m[1]);
    for (const field of fields)
      assert.ok(
        [
          'name',
          'description',
          'license',
          'allowed-tools',
          'metadata',
          'compatibility',
        ].includes(field as string),
        `${name}: field ${field}`,
      );
    assert.equal(/^name: (.+)$/mu.exec(head)?.[1], name);
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/u);
    const description = /^description: (.+)$/mu.exec(head)?.[1] ?? '';
    assert.ok(description.length > 0 && description.length <= 1024, name);
    assert.equal(/[<>]/u.test(description), false, `${name} description`);
  }
});

function adoptFixture(marker: string): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-set-adopt-'));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  writeFileSync(join(root, marker), '');
  const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'adopt', root, '--no-canary'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return root;
}

test('krn adopt installs every file of the boilerplate skills into a WordPress repository, and drift reports an edited copy', () => {
  const root = adoptFixture('wp-config.php');
  try {
    for (const name of wordpressSkills)
      for (const file of filesUnder(join(SITE_SKILLS_DIR, name)))
        assert.equal(
          readFileSync(join(root, '.agents', 'skills', name, file), 'utf8'),
          readFileSync(join(SITE_SKILLS_DIR, name, file), 'utf8'),
          `${name}/${file}`,
        );
    assert.equal(existsSync(join(root, '.agents/skills/plesk-deploy')), false);
    assert.deepEqual(adoptionDrift(root).drifted, []);
    const stale = '.agents/skills/cube-css/references/tokens.md';
    writeFileSync(join(root, stale), 'older source\n');
    assert.deepEqual(adoptionDrift(root).drifted, [stale]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
