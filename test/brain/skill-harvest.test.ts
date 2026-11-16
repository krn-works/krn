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
  harvestRules,
  harvestSkills,
  SKILL_PLACEMENT,
  SKILL_RULES,
} from '../../src/brain/skill-harvest.ts';
import {
  appliesTo,
  parseStandards,
  StandardsDataError,
} from '../../src/brain/standards.ts';
import { repositoryFacts } from '../../src/brain/standards-cli.ts';
import { editRecords, lanePacket } from '../../src/brain/worker-packet.ts';

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
const EDIT_AS_OF = '2026-11-15';

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

const TS_SKILL = '.agents/skills/typescript/SKILL.md';
const tsSource = {
  path: TS_SKILL,
  text: readFileSync(join(capture, TS_SKILL), 'utf8'),
};

function ruleRecords() {
  return harvestRules([...skillSources(), tsSource], COMMIT, AS_OF);
}

test('every skill rule becomes one accepted, scoped, one-sentence record that cites its source line', () => {
  const records = ruleRecords();
  assert.equal(records.length, SKILL_RULES.length);
  assert.ok(records.length >= 25, `${records.length} rules`);
  parseUnified(JSON.parse(JSON.stringify(records)));
  const texts = new Map(
    [...skillSources(), tsSource].map((s) => [s.path, s.text.split('\n')]),
  );
  for (const record of records) {
    const { stacks, paths } = record.applies;
    assert.ok(stacks.length + paths.length > 0, `${record.id} has no scope`);
    assert.equal(record.status, 'accepted');
    assert.equal(record.enforcement.kind, 'advisory');
    assert.ok(record.text.split(/\s+/u).length <= 25, record.id);
    assert.equal(record.text.split(/(?<=\.)\s/u).length, 1, record.id);
    const cited = record.provenance.origin.split(' ')[1];
    const [path = '', line = ''] = (cited ?? '').split(/:(?=\d+$)/u);
    assert.ok(
      (texts.get(path)?.[Number(line) - 1] ?? '').length > 0,
      `${record.id} cites ${cited}`,
    );
    assert.ok(record.provenance.evidence.includes(COMMIT));
    assert.equal(
      record.layer,
      undefined,
      'served at the edit, not inherited as prose',
    );
  }
  assert.ok(
    records
      .filter((r) => r.id.startsWith('s-ts-'))
      .every((r) => r.applies.stacks.includes('node')),
  );
});

test('a rule whose anchor left its skill is refused naming the path and the rule', () => {
  assert.throws(
    () =>
      harvestRules(
        [{ path: TS_SKILL, text: '---\nname: typescript\n---\nnothing\n' }],
        COMMIT,
        AS_OF,
      ),
    (error) =>
      error instanceof StandardsDataError &&
      error.message.startsWith(`${TS_SKILL}: rule s-ts-`),
  );
});

test('the shipped pack holds every harvested rule with its scope and evidence', () => {
  const shipped = parseStandards(JSON.parse(readFileSync(pack, 'utf8')));
  for (const record of ruleRecords()) {
    const held = shipped.find((s) => s.id === record.id);
    assert.ok(held, `${record.id} is in standards/records.json`);
    assert.equal(held.text, record.text);
    assert.equal(held.status, 'accepted');
    // The shipped record also carries retrieval terms; the scope is what the harvest fixes.
    assert.deepEqual(
      { ...held.applies, terms: [] },
      { ...record.applies, terms: [] },
    );
    assert.deepEqual(held.provenance.origin, record.provenance.origin);
    assert.equal(held.provenance.evidence.length, 1);
    assert.match(held.provenance.evidence[0] ?? '', /^[0-9a-f]{40}$/u);
  }
});

test('the first edit of a .ts file serves harvested node records and a stylesheet edit in a theme serves the CUBE ones', () => {
  const node = repository(plain);
  const wp = repository({
    ...wordpress,
    'package.json': '{"devDependencies":{"vite":"^6"}}\n',
  });
  try {
    const ts = editRecords(node, 'src/a.ts', EDIT_AS_OF).map((s) => s.id);
    assert.ok(ts.includes('s-ts-parse-at-edge'), ts.join());
    assert.ok(!ts.some((id) => id.startsWith('s-css-')));
    const js = editRecords(node, 'src/a.js', EDIT_AS_OF).map((s) => s.id);
    assert.ok(!js.includes('s-ts-parse-at-edge'));
    const css = editRecords(
      wp,
      'web/app/themes/site/src/css/blocks/a.css',
      EDIT_AS_OF,
    ).map((s) => s.id);
    assert.ok(css.includes('s-css-token-values'), css.join());
    const php = editRecords(wp, 'web/app/themes/site/page.php', EDIT_AS_OF).map(
      (s) => s.id,
    );
    assert.ok(php.includes('s-wp-escape-output'), php.join());
  } finally {
    rmSync(node, { recursive: true, force: true });
    rmSync(wp, { recursive: true, force: true });
  }
});

test('krn standards query for a .ts file returns a harvested node record', () => {
  const node = repository(plain);
  try {
    const done = krn(
      ['standards', 'query', '--file', 'src/a.ts', 'typescript'],
      node,
    );
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /\[s-ts-[a-z-]+\]/u);
  } finally {
    rmSync(node, { recursive: true, force: true });
  }
});

test('harvest --skills --rules prints the rule records of a repository and leaves it unchanged', () => {
  const root = repository({});
  try {
    cpSync(join(capture, '.claude'), join(root, '.claude'), {
      recursive: true,
    });
    mkdirSync(join(root, '.agents/skills/typescript'), { recursive: true });
    writeFileSync(join(root, TS_SKILL), tsSource.text);
    const before = spawnSync('git', ['status', '--short'], {
      cwd: root,
      encoding: 'utf8',
    }).stdout;
    const done = krn(
      ['standards', 'harvest', '--skills', root, '--rules', '--commit', COMMIT],
      root,
    );
    assert.equal(done.status, 0, done.stderr);
    const records = parseUnified(JSON.parse(done.stdout));
    assert.equal(records.length, SKILL_RULES.length);
    assert.equal(
      spawnSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' })
        .stdout,
      before,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
