import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const api = await import('../../src/brief/sections.ts').catch(() => undefined);
const cli = resolve('src/cli/main.ts');
const observer = 'test/brief/example.test.ts';
const body = (paths = 'src/a.ts') =>
  `## Allowed paths\n${paths}\n## Steps\n1. Run ${observer} red\n## Proof\n\`${observer}\`\n## Hardening\n- symlink: covered\n`;
function setup(t: { after(fn: () => void): void }) {
  assert.equal(typeof api?.briefSections, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'krn-allowed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  mkdirSync(join(dir, 'spec'));
  writeFileSync(
    join(dir, 'spec/worker-scope.json'),
    JSON.stringify({
      supportedVersions: ['0.166.0'],
      forbidden: ['.agents/**', 'tasks/**'],
      review: [],
    }),
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'fixture',
  );
  writeFileSync(join(dir, 'checklist'), '- `symlink`: paths\n');
  const check = (text: string, ...args: string[]) => {
    writeFileSync(join(dir, 'brief'), text);
    return run('brief', 'check', 'brief', '--checklist', 'checklist', ...args);
  };
  return { dir, run, check };
}
test('section grammar: commas, bullets, annotation, BOM, CRLF and fences', () => {
  assert.equal(typeof api?.briefSections, 'function');
  const s = api?.briefSections(
    `\uFEFF\`\`\`md\r\n## Allowed paths\r\nignored\r\n\`\`\`\r\n   ## Allowed paths\r\n\`src/a.ts\`, \`src/b.ts\` (new),\r\n- test/c.test.ts (observer)\r\n## Steps\r\n1. Run ${observer} RED\r\n## Proof\r\n\`${observer}\`\r\n`,
  );
  assert.deepEqual(s?.allowed, [
    { path: 'src/a.ts', isNew: false },
    { path: 'src/b.ts', isNew: true },
    { path: 'test/c.test.ts', isNew: false },
  ]);
  assert.equal(s?.observer, observer);
});
test('repo checks refuse malformed contracts and forbidden paths; legacy output stays identical', (t) => {
  const f = setup(t);
  assert.deepEqual(
    [f.check(body()).status, f.check(body()).stdout, f.check(body()).stderr],
    [0, 'PASS brief\n', ''],
  );
  for (const text of [
    body().replace('## Steps', '## Other'),
    body().replace(`${observer} red`, 'other red'),
    body().replace(' red', ' green'),
    body().replace(`## Proof\n\`${observer}\``, '## Proof\nnone'),
    body().replace('## Allowed paths', '## Other'),
    body(''),
    body('a\n## Allowed paths\nb'),
    body(Array.from({ length: 101 }, (_, i) => `src/${i}`).join(',')),
  ]) {
    const r = f.check(text, '--repo', f.dir);
    assert.equal(r.status, 65, r.stderr);
  }
  const denied = f.check(
    body('.agents/skills/x/SKILL.md, tasks/t-x.json'),
    '--repo',
    f.dir,
  );
  assert.equal(denied.status, 65);
  assert.equal(denied.stderr.trim().split('\n').length, 2);
  assert.match(denied.stderr, /tasks\/t-x.json is forbidden/);
  const pass = f.check(body('`src/a.ts` (new)'), '--repo', f.dir);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(
    pass.stdout,
    /argv: --allow 'src\/a.ts' --require 'src\/a.ts' --observer/,
  );
});
test('routing warnings and verbatim lens', (t) => {
  const f = setup(t);
  for (const [paths, model, warn] of [
    ['a,b,c,d', 'gpt-6-luna', true],
    ['a,b,c,d', 'gpt-6.1-sol', false],
    ['test/a,test/b,test/c,test/d', 'gpt-6-luna', false],
  ] as const) {
    const r = f.check(body(paths), '--repo', f.dir, '--model', model);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stderr.includes('WARN route: 4 non-test paths; use gpt-6.1-sol'),
      warn,
    );
  }
  const verbatim = '\r\nKeep this.\r\n```\r\n## hidden\r\n```\r\n';
  writeFileSync(
    join(f.dir, 'brief'),
    `## Settled decisions\r\n${verbatim}## Next\r\n`,
  );
  assert.equal(
    f.run('brief', 'lens', 'brief').stdout,
    'Settled decisions (verbatim from the brief; do not re-decide or flag them):\n' +
      verbatim,
  );
  writeFileSync(join(f.dir, 'brief'), body());
  assert.equal(f.run('brief', 'lens', 'brief').status, 65);
});
test('worker start compares sets before writing', (t) => {
  const f = setup(t);
  writeFileSync(join(f.dir, 'brief'), body('src/a.ts,src/b.ts'));
  const run = join(f.dir, '.krn/runs/worker');
  const args = [
    'worker',
    'start',
    '--repo',
    f.dir,
    '--run',
    run,
    '--brief',
    join(f.dir, 'brief'),
    '--model',
    'gpt-6.1-sol',
  ];
  const mismatch = f.run(...args, '--allow', 'src/c.ts');
  assert.equal(mismatch.status, 64, mismatch.stderr);
  assert.match(mismatch.stderr, /missing src\/a.ts,src\/b.ts; extra src\/c.ts/);
  assert.equal(existsSync(run), false);
  const telemetry = mkdtempSync(join(tmpdir(), 'krn-receiver-'));
  t.after(() => rmSync(telemetry, { recursive: true, force: true }));
  const bin = join(f.dir, '.krn/bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(f.dir, '.gitignore'), '.krn/\nbrief\nchecklist\n');
  writeFileSync(
    join(bin, 'systemd-run'),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --unit) shift 2;; --*) shift;; *) exec "$@";; esac; done\n',
  );
  writeFileSync(
    join(bin, 'systemctl'),
    '#!/bin/sh\necho "ActiveState=inactive\nControlGroup="\n',
  );
  for (const name of ['systemd-run', 'systemctl'])
    chmodSync(join(bin, name), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    KRN_CODEX_BIN: resolve('test/fixtures/worker/app-server.mjs'),
    CODEX_TEST_WORKER_INITIALIZE_GATE: '',
  };
  for (const [index, text] of [
    body('src/b.ts,src/a.ts'),
    'legacy brief',
    '## Proof\nlegacy\n## Proof\nlegacy',
  ].entries()) {
    writeFileSync(join(f.dir, 'brief'), text);
    const ownRun = `${run}-${index}`;
    const ownEnv = {
      ...env,
      CODEX_TEST_WORKER_LOG: join(telemetry, 'requests.jsonl'),
      CODEX_TEST_WORKER_PID: join(telemetry, 'server.pid'),
    };
    const ownArgs = args.map((value) => (value === run ? ownRun : value));
    try {
      const r = spawnSync(
        process.execPath,
        [cli, ...ownArgs, '--allow', 'src/a.ts', '--allow', 'src/b.ts'],
        { cwd: f.dir, encoding: 'utf8', env: ownEnv, timeout: 30000 },
      );
      assert.equal(r.status, 0, r.stderr);
      const state: unknown = JSON.parse(
        readFileSync(join(ownRun, 'session.json'), 'utf8'),
      );
      assert.ok(
        typeof state === 'object' &&
          state !== null &&
          'status' in state &&
          state.status === 'running',
      );
    } finally {
      const stopped = spawnSync(
        process.execPath,
        [cli, 'worker', 'stop', '--run', ownRun],
        { cwd: f.dir, encoding: 'utf8', env: ownEnv, timeout: 30000 },
      );
      assert.equal(stopped.status, 0, stopped.stderr);
    }
  }
});

test('duplicates are reasons with line numbers and section names are case-sensitive', () => {
  assert.equal(typeof api?.briefSections, 'function');
  for (const name of ['Allowed paths', 'Steps', 'Proof', 'Settled decisions']) {
    assert.throws(
      () => api?.briefSections(`## ${name}\na\n## ${name}\nb`),
      new RegExp(`duplicate ${name} section at line 3`),
    );
  }
  assert.equal(api?.briefSections('## allowed paths\na').allowed, undefined);
  assert.equal(
    api?.briefSections('```\n## Proof\ntest/a.test.ts\n```').observer,
    undefined,
  );
  assert.equal(
    api?.briefSections('## Proof\n`test/nested/a.test.cjs` `test/b.test.js`')
      .observer,
    'test/nested/a.test.cjs',
  );
  assert.equal(
    api?.briefSections('## Settled decisions\nbody without newline').settled,
    'body without newline',
  );
});

test('argv shell quoting preserves spaces and literal shell characters', (t) => {
  const f = setup(t);
  const path = "src/a b'$(echo literal).ts";
  const r = f.check(body(`\`${path}\` (new)`), '--repo', f.dir);
  assert.equal(r.status, 0, r.stderr);
  const argv = r.stdout.split('\n')[1]?.slice('argv: '.length);
  const shell = spawnSync(
    '/bin/sh',
    ['-c', `set -- ${argv}; printf '%s\\n' "$@"`],
    { encoding: 'utf8' },
  );
  assert.equal(shell.status, 0, shell.stderr);
  assert.deepEqual(shell.stdout.trim().split('\n'), [
    '--allow',
    path,
    '--require',
    path,
    '--observer',
    observer,
  ]);
});
