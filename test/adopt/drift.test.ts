import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adoptionDrift, refreshAdoption } from '../../src/adopt/drift.ts';
import { staleAgentText } from '../../src/context/stale-agent-text.ts';

// KRN-12: the real `krn adopt` entry writes the fixture, then drift and refresh read it back.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function git(root: string, ...args: string[]) {
  const run = spawnSync(
    'git',
    ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
}

function adopted(): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-drift-'));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test' } }),
  );
  mkdirSync(join(root, 'tasks'));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  const run = spawnSync(
    process.execPath,
    [cli, 'adopt', root, '--no-canary', '--tracker'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return root;
}

const krnAdopt = (root: string, flag: string) =>
  spawnSync(process.execPath, [cli, 'adopt', root, flag], {
    encoding: 'utf8',
  });

test('an untouched adoption has no drift and refresh keeps every file', () => {
  const root = adopted();
  const drift = adoptionDrift(root);
  assert.deepEqual([drift.drifted, drift.missing], [[], []]);
  const run = krnAdopt(root, '--refresh');
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /^updated /mu);
  assert.match(run.stdout, /^kept \.claude\/settings\.json$/mu);
});

test('an edited hook file and a deleted standards record are each named and drift leaves the files as found', () => {
  const root = adopted();
  const settings = join(root, '.claude/settings.json');
  writeFileSync(settings, '{}\n');
  rmSync(join(root, '.agents/standards.json'));
  const before = readFileSync(settings, 'utf8');
  const drift = adoptionDrift(root);
  assert.ok(drift.drifted.includes('.claude/settings.json'));
  assert.ok(drift.missing.includes('.agents/standards.json'));
  assert.equal(readFileSync(settings, 'utf8'), before);
  assert.equal(existsSync(join(root, '.agents/standards.json')), false);
});

test('refresh updates a standards file that predates tiers, keeps repo-owned files and is idempotent', () => {
  const root = adopted();
  const standards = join(root, '.agents/standards.json');
  const current = JSON.parse(readFileSync(standards, 'utf8')) as {
    tier?: unknown;
  }[];
  for (const record of current) delete record.tier;
  writeFileSync(standards, `${JSON.stringify(current, null, 2)}\n`);
  const contract = join(root, 'krn.json');
  writeFileSync(
    contract,
    '{"base":"main","test":"node --test","tracker":"krn"}\n',
  );
  const owned = readFileSync(contract, 'utf8');
  const first = krnAdopt(root, '--refresh');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^updated \.agents\/standards\.json$/mu);
  assert.equal(readFileSync(contract, 'utf8'), owned);
  const second = krnAdopt(root, '--refresh');
  assert.doesNotMatch(second.stdout, /^updated /mu);
  assert.match(second.stdout, /^kept \.agents\/standards\.json$/mu);
});

test('refreshAdoption rewrites a drifted skill file', () => {
  const root = adopted();
  const skill = readdirSkill(root);
  writeFileSync(skill, 'edited\n');
  assert.deepEqual(refreshAdoption(root).drifted, [
    skill.slice(root.length + 1),
  ]);
  assert.notEqual(readFileSync(skill, 'utf8'), 'edited\n');
});

function readdirSkill(root: string): string {
  const dir = join(root, '.agents/skills');
  const name = spawnSync('ls', [dir], { encoding: 'utf8' }).stdout.split(
    '\n',
  )[0];
  return join(dir, name as string, 'SKILL.md');
}

import { missingPackRecords } from '../../src/adopt/drift.ts';
import { pruneRegistry } from '../../src/brain/adopted-registry.ts';
import { packsReport } from '../../src/cli/doctor-packs.ts';

function dropRecords(root: string, count: number): string[] {
  const standards = join(root, '.agents/standards.json');
  const all = JSON.parse(readFileSync(standards, 'utf8')) as { id: string }[];
  const dropped = all.splice(0, count).map((record) => record.id);
  writeFileSync(standards, `${JSON.stringify(all, null, 2)}\n`);
  return dropped;
}

test('a repository adopted on the pack minus five records reports five missing, verify and doctor exit non-zero with the remedy, refresh-all brings it to zero', () => {
  const root = adopted();
  assert.deepEqual(missingPackRecords(root), []);
  const dropped = dropRecords(root, 5);
  assert.deepEqual([...missingPackRecords(root)].sort(), [...dropped].sort());

  const verify = krnAdopt(root, '--verify');
  assert.equal(verify.status, 1);
  const lines = verify.stdout
    .split('\n')
    .filter((line) => line.startsWith('verify drift: pack record '));
  assert.equal(lines.length, 5);
  assert.match(lines[0] as string, /run krn adopt .* --refresh$/u);

  const registry = join(
    mkdtempSync(join(tmpdir(), 'krn-reg-')),
    'adopted.json',
  );
  writeFileSync(registry, JSON.stringify([root]));
  const stale = packsReport(registry);
  assert.equal(stale.exitCode, 65);
  assert.match(stale.text, /lacks 5 pack records/u);
  assert.match(stale.text, /krn adopt --refresh-all/u);

  const env = { ...process.env, KRN_ADOPTED_REGISTRY: registry };
  const refresh = spawnSync(process.execPath, [cli, 'adopt', '--refresh-all'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(refresh.status, 0, refresh.stdout + refresh.stderr);
  assert.match(refresh.stdout, /^refreshed .*: \d+ updated$/mu);
  assert.deepEqual(missingPackRecords(root), []);
  assert.equal(packsReport(registry).exitCode, 0);
  assert.equal(
    krnAdopt(root, '--verify').stdout.includes('pack record'),
    false,
  );
});

test('refresh-all with no registered repository is a usage error', () => {
  const run = spawnSync(process.execPath, [cli, 'adopt', '--refresh-all'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KRN_ADOPTED_REGISTRY: join(tmpdir(), 'krn-none-registry.json'),
    },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /no adopted repository registered/u);
});

test('refresh-all and doctor skip a registered path that is not a git repository', () => {
  const gone = mkdtempSync(join(tmpdir(), 'krn-gone-'));
  const registry = join(
    mkdtempSync(join(tmpdir(), 'krn-reg-')),
    'adopted.json',
  );
  writeFileSync(registry, JSON.stringify([gone]));
  assert.equal(packsReport(registry).exitCode, 0);
  const run = spawnSync(process.execPath, [cli, 'adopt', '--refresh-all'], {
    encoding: 'utf8',
    env: { ...process.env, KRN_ADOPTED_REGISTRY: registry },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^skipped .*: not a git repository$/mu);
});

test('registry reads drop a path that no longer exists, rewrite the file and report the count', () => {
  const live = mkdtempSync(join(tmpdir(), 'krn-live-'));
  const gone = join(tmpdir(), 'krn-never-existed-registry-entry');
  const registry = join(
    mkdtempSync(join(tmpdir(), 'krn-reg-')),
    'adopted.json',
  );
  writeFileSync(registry, JSON.stringify([gone, live, `${gone}-2`]));
  assert.deepEqual(pruneRegistry(registry), { roots: [live], pruned: 2 });
  assert.deepEqual(JSON.parse(readFileSync(registry, 'utf8')), [live]);
  assert.deepEqual(pruneRegistry(registry), { roots: [live], pruned: 0 });

  writeFileSync(registry, JSON.stringify([gone, live]));
  assert.match(
    packsReport(registry).text,
    /^registry-pruned=1 missing paths/mu,
  );
  const run = spawnSync(process.execPath, [cli, 'adopt', '--refresh-all'], {
    encoding: 'utf8',
    env: { ...process.env, KRN_ADOPTED_REGISTRY: registry },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^skipped .*: not a git repository$/mu);
});

test('drift reports a deleted skill support file as missing', () => {
  const root = adopted();
  try {
    rmSync(join(root, '.agents/skills/delivery-lead/lanes.md'));
    const drift = adoptionDrift(root);
    assert.ok(
      drift.missing.includes('.agents/skills/delivery-lead/lanes.md'),
      JSON.stringify(drift),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// KRN adopts itself: the skills in .agents/skills that the installer owns are its output, never hand-written.
test('this repository has no adoption drift in the skills the installer writes', () => {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const drift = adoptionDrift(repo);
  const skills = [...drift.drifted, ...drift.missing].filter((file) =>
    file.startsWith('.agents/skills/'),
  );
  assert.deepEqual(skills, []);
  assert.ok(
    drift.kept.includes('.agents/skills/delivery-lead/SKILL.md'),
    'delivery-lead is installed here',
  );
  assert.ok(drift.kept.includes('.agents/skills/delivery-lead/lanes.md'));
});

// repository-workflow.md once said every universal skill is installed here unchanged, while
// .agents/skills/architecture is a hand-kept KRN variant the installer never writes.
test('repository-workflow names exactly the skills the installer writes here', () => {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const owned = adoptionDrift(repo)
    .kept.map(
      (file) => /^\.agents\/skills\/([^/]+)\/SKILL\.md$/u.exec(file)?.[1],
    )
    .filter((name) => name !== undefined)
    .sort();
  const doc = readFileSync(
    join(repo, 'docs/program/repository-workflow.md'),
    'utf8',
  );
  const claim = /This repository installs (.+?) unchanged/u.exec(doc)?.[1];
  assert.ok(claim, 'repository-workflow.md states which skills are installed');
  const named = [...claim.matchAll(/`([a-z-]+)`/gu)].map((m) => m[1]).sort();
  assert.deepEqual(named, owned);
  assert.ok(!owned.includes('architecture'));
});

// The agent-text check reads the skills under the Claude config directory and the window from its settings.
function withAgentText(text: string, file = 'AGENTS.md') {
  const root = adopted();
  const config = mkdtempSync(join(tmpdir(), 'krn-drift-cfg-'));
  mkdirSync(join(config, 'skills/context-relay/scripts'), { recursive: true });
  writeFileSync(join(config, 'skills/context-relay/SKILL.md'), '# relay\n');
  writeFileSync(join(config, 'skills/context-relay/scripts/relay.sh'), '');
  writeFileSync(
    join(config, 'settings.json'),
    JSON.stringify({ autoCompactWindow: 400000 }),
  );
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, file), text);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
  const found = () => {
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      return staleAgentText(root);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  };
  return { root, env, found };
}

test('agent text naming a removed skill script is reported with file and line', () => {
  const { root, env, found } = withAgentText(
    [
      'Start.',
      'mierz kontekst (`python3 ~/.claude/skills/context-relay/scripts/context-usage.py`)',
      'relay: ~/.claude/skills/context-relay/scripts/relay.sh',
      'See .agents/skills/gone-skill/run.sh.',
    ].join('\n'),
  );
  assert.deepEqual(found(), [
    'AGENTS.md:2 names ~/.claude/skills/context-relay/scripts/context-usage.py, which does not exist',
    'AGENTS.md:4 names .agents/skills/gone-skill/run.sh, which does not exist',
  ]);
  const run = spawnSync(
    process.execPath,
    [cli, 'adopt', root, '--refresh', '--dry-run'],
    {
      encoding: 'utf8',
      env,
    },
  );
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(
    run.stdout,
    /^stale AGENTS\.md:2 names ~\/\.claude\/skills\/context-relay\/scripts\/context-usage\.py/mu,
  );
});

test('a relay threshold that is none of the window advisories is reported, the advisories themselves are not', () => {
  const { found } = withAgentText(
    [
      'hook nadal wypisuje komunikat przy 150k',
      'relay przy ~150k z 400k',
      'handoff at 200k, relay at 250k, ceiling 300k of 400k',
      'Model has 128k output; unrelated 90k budget.',
    ].join('\n'),
    'docs/NEXT-PROMPT.md',
  );
  assert.deepEqual(found(), [
    'docs/NEXT-PROMPT.md:1 states 150k; the gauge advises at 200k and 250k of a 400k window',
    'docs/NEXT-PROMPT.md:2 states 150k; the gauge advises at 200k and 250k of a 400k window',
  ]);
});

test('current wording and history logs pass', () => {
  const { root, found } = withAgentText(
    'Relay at 200k and 250k of the 400k window; use ~/.claude/skills/context-relay/scripts/relay.sh.\n',
  );
  writeFileSync(
    join(root, 'docs/HISTORY-PROMPT.md'),
    'relay at 150k via ~/.claude/skills/x/y.py\n',
  );
  assert.deepEqual(found(), []);
});
