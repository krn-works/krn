import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
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
import { parseUnified } from '../../src/brain/record.ts';
import {
  harvestSkills,
  SKILL_PLACEMENT,
} from '../../src/brain/skill-harvest.ts';
import {
  appliesTo,
  parseStandards,
  StandardsDataError,
} from '../../src/brain/standards.ts';
import { repositoryFacts } from '../../src/brain/standards-cli.ts';
import { lanePacket } from '../../src/brain/worker-packet.ts';

// The six boilerplate-2026 SKILL.md files are a verbatim capture under the fixture root; the
// commit is the one that last changed them there.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const capture = fileURLToPath(
  new URL('../fixtures/boilerplate-skills', import.meta.url),
);
const pack = fileURLToPath(
  new URL('../../standards/records.json', import.meta.url),
);
const COMMIT = '7d1cc401683a6febb331175300045c3a7065efe6';
const NAMES = Object.keys(SKILL_PLACEMENT).sort();
const AS_OF = '2026-11-14';

function skillSources() {
  return NAMES.map((name) => {
    const path = `.claude/skills/${name}/SKILL.md`;
    return { path, text: readFileSync(join(capture, path), 'utf8') };
  });
}

function krn(args: string[], cwd = tmpdir()) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    cwd,
  });
}

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-skill-harvest-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const init = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  assert.equal(init.status, 0);
  return root;
}

const wordpress = {
  'composer.json': '{"require": {"roots/bedrock": "^1"}}\n',
  'web/app/themes/site/style.css': '/*\nTheme Name: Site\n*/\n',
};
const plain = {
  'package.json': '{"name": "probe", "scripts": {"test": "node --test"}}\n',
};

test('the capture harvests into six trial records of the one schema, tied to its skill path and commit', () => {
  const records = harvestSkills(skillSources(), COMMIT, AS_OF);
  assert.deepEqual(records.map((r) => r.id).sort(), [
    's-skill-acf-component',
    's-skill-cube-css',
    's-skill-cube-review',
    's-skill-design-to-build',
    's-skill-plesk-deploy',
    's-skill-wp-runtime',
  ]);
  parseUnified(JSON.parse(JSON.stringify(records)));
  parseStandards(JSON.parse(JSON.stringify(records)));
  for (const record of records) {
    const name = record.id.replace('s-skill-', '');
    assert.equal(record.status, 'trial');
    assert.equal(record.audience, 'worker');
    assert.equal(record.enforcement.kind, 'advisory');
    assert.deepEqual(record.applies.needs, [record.area]);
    assert.ok(['frontend', 'wordpress'].includes(record.area ?? ''));
    assert.ok(record.applies.paths.length > 0);
    assert.equal(
      record.provenance.origin,
      `boilerplate-2026 .claude/skills/${name}/SKILL.md`,
    );
    assert.deepEqual(record.provenance.evidence, [COMMIT]);
    const description = /^description: (.+)$/mu.exec(
      readFileSync(join(capture, `.claude/skills/${name}/SKILL.md`), 'utf8'),
    )?.[1];
    assert.equal(record.text, description);
    assert.ok(record.text.length <= 450, `${name} text is a statement`);
  }
  const globs = records.flatMap((r) => r.applies.paths).join(' ');
  for (const glob of [
    '**/*.php',
    '**/*.css',
    '**/acf-json/*.json',
    'web/app/themes/**',
  ])
    assert.ok(globs.includes(glob), glob);
});

test('the plainest hand-written skill file harvests; a file without a description or an unknown skill is refused naming its path', () => {
  const plainest =
    '---\nname: cube-css\ndescription: Write CSS the CUBE way.\n---\n';
  const [record] = harvestSkills(
    [{ path: '.claude/skills/cube-css/SKILL.md', text: plainest }],
    COMMIT,
    AS_OF,
  );
  assert.equal(record?.text, 'Write CSS the CUBE way.');
  assert.throws(
    () =>
      harvestSkills(
        [{ path: '.claude/skills/x/SKILL.md', text: '# no frontmatter\n' }],
        COMMIT,
        AS_OF,
      ),
    (error) =>
      error instanceof StandardsDataError &&
      error.message.startsWith('.claude/skills/x/SKILL.md: frontmatter needs'),
  );
  assert.throws(
    () =>
      harvestSkills(
        [
          {
            path: '.claude/skills/other/SKILL.md',
            text: '---\nname: other\ndescription: Something.\n---\n',
          },
        ],
        COMMIT,
        AS_OF,
      ),
    /\.claude\/skills\/other\/SKILL\.md: skill other has no placement/u,
  );
});

test('the shipped pack holds the harvested records of the capture, made enforceable or retired and within its size', () => {
  const shipped = parseStandards(JSON.parse(readFileSync(pack, 'utf8')));
  const expected = harvestSkills(skillSources(), COMMIT, AS_OF);
  for (const record of expected) {
    const held = shipped.find((s) => s.id === record.id);
    assert.ok(held, `${record.id} is in standards/records.json`);
    // The pack record is the harvested one made enforceable or retired: its identity, source and
    // placement are the harvest's, its statement, enforcement and status are the pack's.
    assert.equal(held.type, record.type);
    assert.equal(held.area, record.area);
    assert.deepEqual(held.provenance, record.provenance);
    assert.deepEqual(held.applies.paths, record.applies.paths);
    assert.ok(held.status !== 'trial' || held.enforcement.kind === 'advisory');
  }
  const bytes = Buffer.byteLength(JSON.stringify(expected));
  assert.ok(bytes <= 8192, `${bytes} bytes of harvested records`);
});

test('harvest --skills prints the records of a repository and leaves it unchanged', () => {
  const root = repository({});
  try {
    cpSync(join(capture, '.claude'), join(root, '.claude'), {
      recursive: true,
    });
    const status = () =>
      spawnSync('git', ['status', '--short'], {
        cwd: root,
        encoding: 'utf8',
      }).stdout;
    const tree = () =>
      readdirSync(join(root, '.claude/skills'), { recursive: true }).join();
    const before = [status(), tree()];
    const done = krn([
      'standards',
      'harvest',
      '--skills',
      root,
      '--commit',
      COMMIT,
    ]);
    assert.equal(done.status, 0, done.stderr);
    const records = parseUnified(JSON.parse(done.stdout));
    assert.equal(records.length, 6);
    assert.deepEqual([status(), tree()], before);
    const noSkills = krn(['standards', 'harvest', '--skills', tmpdir()]);
    assert.equal(noSkills.status, 66, noSkills.stderr);
    assert.match(noSkills.stderr, /holds no skills/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repositoryFacts finds WordPress and frontend repositories and not a plain node one', () => {
  const wp = repository(wordpress);
  const build = repository({
    'package.json': '{"devDependencies": {"vite": "^6"}}\n',
  });
  const node = repository(plain);
  try {
    assert.deepEqual([...repositoryFacts(wp).needs].sort(), [
      'frontend',
      'wordpress',
    ]);
    assert.deepEqual([...repositoryFacts(build).needs], ['frontend']);
    assert.deepEqual([...repositoryFacts(node).needs], []);
  } finally {
    for (const root of [wp, build, node])
      rmSync(root, { recursive: true, force: true });
  }
});

test('an adopted WordPress repository applies the enforced skill records and a non-frontend repository does not', () => {
  const brief =
    'Add a new ACF flexible content layout component with a static PHP template and CUBE block CSS for the WordPress theme, then deploy the release to Plesk.';
  const wp = repository(wordpress);
  const node = repository(plain);
  try {
    for (const root of [wp, node]) {
      const adopted = krn(['adopt', root, '--no-canary']);
      assert.equal(adopted.status, 0, adopted.stderr);
    }
    const served = lanePacket(wp, brief, AS_OF, 'lane', 600, false);
    // An enforced record is taught by its check, and a retired one is never served.
    assert.deepEqual(
      served?.records.filter((id) => id.startsWith('s-skill-')) ?? [],
      [],
    );
    const withheld = lanePacket(node, brief, AS_OF, 'lane', 600, false);
    assert.deepEqual(
      withheld?.records.filter((id) => id.startsWith('s-skill-')) ?? [],
      [],
    );
    const shipped = parseStandards(JSON.parse(readFileSync(pack, 'utf8')));
    const skill = shipped.find((s) => s.id === 's-skill-acf-component');
    assert.ok(skill);
    assert.equal(appliesTo(skill, repositoryFacts(wp)), true);
    assert.equal(appliesTo(skill, repositoryFacts(node)), false);
  } finally {
    for (const root of [wp, node])
      rmSync(root, { recursive: true, force: true });
  }
});
