import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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

const path = (name: string) =>
  fileURLToPath(new URL(`../../scripts/claude/${name}`, import.meta.url));
const inbox = path('operator-inbox.ts');
const handoffCheck = path('handoff-requests.ts');
const restart = path('context-restart.ts');
const settings = fileURLToPath(
  new URL('../../.claude/settings.json', import.meta.url),
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'operator-inbox-'));
  mkdirSync(join(root, 'tasks'));
  writeFileSync(join(root, 'tasks/t-abc1234.json'), '{}');
  const submit = (prompt: string, session = 'sess-1') =>
    spawnSync(process.execPath, [inbox, 'capture'], {
      input: JSON.stringify({ session_id: session, prompt, cwd: root }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
    });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [inbox, ...args, '--root', root], {
      encoding: 'utf8',
    });
  const handoff = () => {
    const file = join(root, 'handoff.md');
    writeFileSync(file, '# Handoff\n\n## Operator requests\n- none\n');
    return spawnSync(
      process.execPath,
      [handoffCheck, file, '--root', root, '--memory', join(root, 'memory')],
      { encoding: 'utf8' },
    );
  };
  return { root, submit, run, handoff };
}

const directive =
  'Please make CI work like T3 with sharded runners and one aggregate check';

test('a prompt sequence: an undisposed directive fails the handoff naming it, a disposition clears it', () => {
  const { root, submit, run, handoff } = fixture();
  try {
    submit('ok');
    submit('what does the gauge do?');
    submit(directive);
    const failed = handoff();
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(
      failed.stderr,
      /no disposition: "Please make CI work like T3/u,
    );
    assert.doesNotMatch(failed.stderr, /gauge/u);
    const [hash] = run('open').stdout.split(' ');
    assert.match(hash ?? '', /^[0-9a-f]{12}$/u);
    assert.equal(run('dispose', hash ?? '', '--task', 't-nope000').status, 1);
    assert.equal(run('dispose', hash ?? '', '--task', 't-abc1234').status, 0);
    const passed = handoff();
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(run('open').stdout, /^0 open/u);
    // After a passing handoff the next session starts clean.
    submit('A second directive that is long enough to be a request');
    assert.equal(handoff().status, 1);
    assert.equal(
      run(
        'dispose',
        run('open').stdout.split(' ')[0] ?? '',
        '--answered',
        'answered in turn',
      ).status,
      0,
    );
    assert.equal(handoff().status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture redacts secrets, bounds length, and never fails the prompt', () => {
  const { root, submit } = fixture();
  try {
    const key = `sk-ant-api03-${'a'.repeat(30)}`;
    const result = submit(
      `use ${key} and GITHUB_TOKEN=abcdef123 then ${'x'.repeat(9000)}`,
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    const raw = readFileSync(join(root, '.krn/operator/inbox.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /sk-ant|abcdef123/u);
    const entry = JSON.parse(raw);
    assert.match(entry.text, /\[REDACTED\]/u);
    assert.ok(entry.text.length <= 4000);
    assert.equal(entry.session, 'sess-1');
    assert.match(entry.time, /^\d{4}-\d\d-\d\dT.*Z$/u);
    assert.equal(
      spawnSync(process.execPath, [inbox, 'capture'], {
        input: 'not json',
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      }).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture hook is registered and fast', () => {
  const config = JSON.parse(readFileSync(settings, 'utf8'));
  const commands = JSON.stringify(config.hooks.UserPromptSubmit);
  assert.match(commands, /operator-inbox\.ts\\" capture/u);
  const { root, submit } = fixture();
  try {
    submit('warm up the module cache for this directive prompt');
    const times: number[] = [];
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      submit(`directive number ${index} that is long enough to count`);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    // Generous bound against loaded CI runners; typical is a node start-up (~40 ms).
    assert.ok((times[2] ?? 0) < 400, `median ${times[2]} ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('search finds prior mentions in tasks and memory, so absence claims are checkable', () => {
  const { root, run } = fixture();
  try {
    writeFileSync(
      join(root, 'tasks/t-skill01.json'),
      JSON.stringify({ title: 'TypeScript skill recommendation' }),
    );
    mkdirSync(join(root, 'memory'));
    const hit = run(
      'search',
      'typescript',
      'skill',
      '--memory',
      join(root, 'memory'),
    );
    assert.match(hit.stdout, /2\/2 .*t-skill01\.json/u);
    const miss = run('search', 'zzzunknown', '--memory', join(root, 'memory'));
    assert.match(miss.stdout, /no mention of: zzzunknown/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('session start names open inbox entries in one bounded line', () => {
  const { root, submit } = fixture();
  try {
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-b', 'fixture');
    git(
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@e.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'f',
    );
    submit(directive);
    const result = spawnSync(process.execPath, [restart], {
      input: JSON.stringify({
        session_id: 's1',
        transcript_path: join(root, 't.jsonl'),
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
    });
    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext as string;
    assert.match(context, /Operator inbox: 1 open prompt/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
