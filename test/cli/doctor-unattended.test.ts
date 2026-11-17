import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skillsMissingPermission } from '../../src/cli/doctor-skills.ts';
import {
  type Probe,
  serveElapsedSeconds,
  unattendedReport,
} from '../../src/cli/doctor-unattended.ts';

const capture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/bw-serve/${name}`, import.meta.url),
    'utf8',
  );
const secret = 'ghs_SECRETTOKENVALUE';

function stub(options: {
  mint?: number;
  etimes?: number | null;
  status?: string;
  unit?: string;
}): Probe {
  return (command, args) => {
    if (command === 'curl')
      return {
        status: 0,
        stdout: capture(options.status ?? 'status-unlocked.json'),
        stderr: '',
      };
    if (command === 'systemctl')
      return {
        status: 0,
        stdout: capture(options.unit ?? 'systemctl-show-failed.txt'),
        stderr: '',
      };
    if (command === 'journalctl')
      return { status: 0, stdout: capture('journal-failed.txt'), stderr: '' };
    if (command === 'ss') {
      assert.deepEqual(args, ['-H', '-ltnp', 'sport = :8087']);
      return options.etimes === null
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 0, stdout: capture('ss-listen.txt'), stderr: '' };
    }
    if (command === 'ps') {
      assert.deepEqual(args, ['-o', 'etimes=', '-p', '3650474']);
      return { status: 0, stdout: `  ${options.etimes}\n`, stderr: '' };
    }
    return options.mint === 0 || options.mint === undefined
      ? { status: 0, stdout: `${secret}\n`, stderr: '' }
      : { status: 69, stdout: '', stderr: 'bw serve unavailable\nmore' };
  };
}

test('the captured ps output parses as whole seconds', () => {
  assert.equal(
    serveElapsedSeconds(
      (command) =>
        command === 'ss'
          ? { status: 0, stdout: capture('ss-listen.txt'), stderr: '' }
          : { status: 0, stdout: capture('ps-etimes.txt'), stderr: '' },
      {},
    ),
    9374,
  );
});

test('passes when the token mints and the session outlives the window, without printing the token', () => {
  const report = unattendedReport(
    ['--unattended', '--window-hours', '6'],
    {},
    stub({ etimes: 3600 }),
  );
  assert.equal(report.exitCode, 0);
  assert.match(report.text, /^PASS unattended/u);
  assert.ok(!report.text.includes(secret));
});

test('exits 69 naming bw-up when the mint fails', () => {
  const report = unattendedReport(
    ['--unattended'],
    {},
    stub({ mint: 1, etimes: 10 }),
  );
  assert.equal(report.exitCode, 69);
  assert.match(report.text, /bw serve unavailable.*bw-up/u);
});

test('a failed mint names the failed bw-serve unit, its EADDRINUSE journal line and that bw-up is an operator command', () => {
  const report = unattendedReport(
    ['--unattended'],
    {},
    stub({ mint: 1, etimes: 10 }),
  );
  assert.equal(report.exitCode, 69);
  assert.match(report.text, /bw-serve\.service is failed/u);
  assert.match(report.text, /EADDRINUSE/u);
  assert.match(report.text, /operator.*interactive shell/u);
});

test('an absent bw-serve unit is named absent with no journal line', () => {
  const report = unattendedReport(
    ['--unattended'],
    {},
    stub({ mint: 1, unit: 'systemctl-show-absent.txt' }),
  );
  assert.match(report.text, /bw-serve\.service is absent;/u);
});

test('an inactive bw-serve unit is named inactive', () => {
  const report = unattendedReport(
    ['--unattended'],
    {},
    stub({ mint: 1, unit: 'systemctl-show-inactive.txt' }),
  );
  assert.match(report.text, /bw-serve\.service is inactive/u);
});

test('fails vault with exit 75 when the captured /status body is locked, though the mint is served from cache', () => {
  const report = unattendedReport(
    ['--unattended'],
    {},
    stub({ etimes: 60, status: 'status-locked.json' }),
  );
  assert.equal(report.exitCode, 75);
  assert.match(report.text, /^FAIL vault: .*locked.*not unlocked/u);
  assert.ok(!report.text.includes(secret));
});

test('exits 75 with the remedy when the session ends inside the window', () => {
  const report = unattendedReport(
    ['--unattended', '--window-hours', '8'],
    {},
    stub({ etimes: 3 * 3600 }),
  );
  assert.equal(report.exitCode, 75);
  assert.match(report.text, /7\.0h left.*needs 8h.*bw-up/u);
});

test('exits 75 when no bw serve process shows the session age', () => {
  const report = unattendedReport(['--unattended'], {}, stub({ etimes: null }));
  assert.equal(report.exitCode, 75);
});

test('exits 64 on a bad window', () => {
  assert.equal(
    unattendedReport(['--unattended', '--window-hours', 'x'], {}, stub({}))
      .exitCode,
    64,
  );
});

test('exits 67 naming the GitHub App not installed when gh answers the captured 404 for the --root repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-doctor-404-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  spawnSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/private-app.git'],
    { cwd: root },
  );
  const inner = stub({ etimes: 36000 });
  const seen: string[][] = [];
  const probe: Probe = (command, args, env) => {
    if (command !== 'gh') return inner(command, args, env);
    seen.push(args);
    assert.equal(env.GH_TOKEN, secret);
    return {
      status: 1,
      stdout: capture('../gh/repo-not-installed.stdout.json'),
      stderr: capture('../gh/repo-not-installed.stderr.log'),
    };
  };
  const report = unattendedReport(['--unattended', '--root', root], {}, probe);
  assert.equal(report.exitCode, 67);
  assert.match(
    report.text,
    /GitHub App not installed on acme\/private-app: install at https:\/\/github\.com\/apps\/krn-works-delivery\/installations\/new/u,
  );
  assert.deepEqual(seen, [['api', 'repos/acme/private-app', '--silent']]);
  assert.ok(!report.text.includes(secret));
});

function skillRepository(allow: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-skills-'));
  const real = readFileSync(
    new URL('../../.agents/skills/architecture/SKILL.md', import.meta.url),
    'utf8',
  );
  // The real frontmatter of a repository skill, with the declaration the check looks for added.
  const text = real.replace(
    /^---\n/u,
    '---\nallowed-tools: Bash(git status)\n',
  );
  const dir = join(root, '.agents', 'skills', 'architecture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), text);
  mkdirSync(join(root, '.claude'));
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow } }),
  );
  return root;
}

test('a skill declaring allowed-tools without a Skill allow entry fails with exit 1 naming it', () => {
  const root = skillRepository([]);
  const report = unattendedReport(
    ['--unattended', '--root', root],
    {},
    stub({ etimes: 3600 }),
  );
  assert.equal(report.exitCode, 1);
  assert.match(report.text, /^FAIL skills: Skill\(architecture\)/u);
});

test('the same skill passes the skill check once its Skill allow entry exists', () => {
  const root = skillRepository(['Skill(architecture)']);
  assert.deepEqual(skillsMissingPermission(root), []);
});

test('the live repository has an allow entry for every skill that declares allowed-tools or hooks', () => {
  assert.deepEqual(
    skillsMissingPermission(new URL('../..', import.meta.url).pathname),
    [],
  );
});
