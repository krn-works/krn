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

const path = (name: string) =>
  fileURLToPath(new URL(`../../scripts/claude/${name}`, import.meta.url));
const inbox = path('operator-inbox.ts');
const promptHook = path('context-gauge.ts');
const handoffCheck = path('handoff-requests.ts');
const restart = path('context-restart.ts');
const settings = fileURLToPath(
  new URL('../../.claude/settings.json', import.meta.url),
);
// Claude Code kills the capture hook after its configured timeout, so every
// fixture run must finish inside it.
const captureHook = JSON.parse(readFileSync(settings, 'utf8'))
  .hooks.UserPromptSubmit.flatMap(
    (entry: { hooks: { command: string; timeout?: number }[] }) => entry.hooks,
  )
  .find((hook: { command: string }) => /context-gauge\.ts/u.test(hook.command));
const captureTimeoutMs = Number(captureHook?.timeout) * 1000;

// The test runs inside a KRN session whose own KRN_* variables (for example
// KRN_SESSION_CLASS) would leak into the hooks and change their output.
const hostEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('KRN_')),
);
const sessionId = '075c3201-76f7-4eb7-89ac-04c9d53234c3';
// Hook environment of an interactive session and of a headless `claude -p` run (captured).
const interactive = {
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
};
const headless = {
  CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
  CLAUDE_CODE_SESSION_ATTENDED: '0',
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'operator-inbox-'));
  mkdirSync(join(root, 'tasks'));
  writeFileSync(join(root, 'tasks/t-abc1234.json'), '{}');
  const submit = (
    prompt: string,
    session = sessionId,
    env: Record<string, string> = interactive,
  ) =>
    spawnSync(process.execPath, [promptHook], {
      input: JSON.stringify({
        session_id: session,
        prompt,
        cwd: root,
        hook_event_name: 'UserPromptSubmit',
        transcript_path: join(root, 'missing.jsonl'),
      }),
      env: { ...hostEnv, ...env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      timeout: captureTimeoutMs,
    });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [inbox, ...args, '--root', root], {
      encoding: 'utf8',
    });
  const handoff = () => {
    const file = join(root, 'handoff.md');
    writeFileSync(
      file,
      '# Handoff\n\n## Resume\n- Task: t-abc1234\n- SHAs: 5e1ce47\n- Verify: `npm run fast`\n- Roadmap: unchanged (fixture)\n\n## Operator requests\n- none\n',
    );
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
    assert.equal(entry.session, sessionId);
    assert.match(entry.time, /^\d{4}-\d\d-\d\dT.*Z$/u);
    assert.equal(
      spawnSync(process.execPath, [promptHook], {
        input: 'not json',
        env: { ...hostEnv, CLAUDE_PROJECT_DIR: root },
      }).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Verbatim shape of a captured Claude Code background-agent notification.
const notification = `<task-notification>
<task-id>a9e853e5b65d4173a</task-id>
<tool-use-id>toolu_01P7nh8okQXUjXGbtUe1bX3q</tool-use-id>
<output-file>/tmp/claude/tasks/a9e853e5b65d4173a.output</output-file>
<status>completed</status>
<summary>Agent "Run KRN/plain/T3 A/B study" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own.</note>
<result>Runda 2 jest gotowa: 27 przebiegów, wszystkie dokończone bez błędu.</result>
</task-notification>`;

test('harness notifications are not captured and old ones never block a handoff', () => {
  const { root, submit, handoff } = fixture();
  try {
    assert.equal(submit(notification).status, 0);
    assert.equal(
      submit(`<system-reminder>\n${directive}\n</system-reminder>`).status,
      0,
    );
    assert.equal(existsSync(join(root, '.krn/operator/inbox.jsonl')), false);
    // Entries captured before this fix must not block a handoff either.
    mkdirSync(join(root, '.krn/operator'), { recursive: true });
    const entry = {
      hash: 'abc123def456',
      session: 's',
      time: new Date().toISOString(),
      text: notification,
    };
    writeFileSync(
      join(root, '.krn/operator/inbox.jsonl'),
      `${JSON.stringify(entry)}\n`,
    );
    assert.equal(handoff().status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compaction summaries and interrupt markers are not captured', () => {
  const { root, submit } = fixture();
  try {
    assert.equal(
      submit(
        'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.',
      ).status,
      0,
    );
    assert.equal(
      submit('[Request interrupted by user for tool use]').status,
      0,
    );
    assert.equal(existsSync(join(root, '.krn/operator/inbox.jsonl')), false);
    submit('This session should keep the real directive about tests');
    assert.equal(existsSync(join(root, '.krn/operator/inbox.jsonl')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// UserPromptSubmit payload of `claude -p "say ok"` (Claude Code 2.1.316), verbatim except
// redacted paths; it has no headless field, only the hook environment differs.
const headlessPayload =
  '{"session_id":"075c3201-76f7-4eb7-89ac-04c9d53234c3","transcript_path":"/home/user/.claude/projects/-cap-proj/075c3201-76f7-4eb7-89ac-04c9d53234c3.jsonl","cwd":"/cap/proj","prompt_id":"bd14b07b-6378-42df-93ab-e0ce17336956","permission_mode":"auto","hook_event_name":"UserPromptSubmit","prompt":"say ok"}';

test('headless runs and hand-fed benchmark payloads are not captured', () => {
  const { root, submit } = fixture();
  const file = join(root, '.krn/operator/inbox.jsonl');
  try {
    const payload = JSON.parse(headlessPayload);
    const result = spawnSync(process.execPath, [promptHook], {
      input: JSON.stringify({ ...payload, cwd: root, prompt: directive }),
      env: { ...hostEnv, ...headless, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(
      submit(directive, sessionId, {
        ...interactive,
        CLAUDE_CODE_SESSION_ATTENDED: '0',
      }).status,
      0,
    );
    assert.equal(
      submit(directive, sessionId, {
        ...interactive,
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      }).status,
      0,
    );
    assert.equal(submit(`hello bench ${directive}`, 'bench').status, 0);
    assert.equal(existsSync(file), false);
    assert.equal(submit(directive).status, 0);
    assert.equal(
      readFileSync(file, 'utf8').split('\n').filter(Boolean).length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture hook is registered with a timeout every run finishes inside', () => {
  assert.ok(captureTimeoutMs > 0, 'context-gauge hook needs a timeout');
  const { root, submit } = fixture();
  try {
    for (let index = 0; index < 5; index++) {
      const result = submit(
        `directive number ${index} that is long enough to count`,
      );
      assert.equal(result.error, undefined, 'hook outlived its timeout');
      assert.equal(result.status, 0, result.stderr);
    }
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
      env: { ...hostEnv, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
    });
    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext as string;
    assert.match(context, /Operator inbox: 1 open prompt/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session started by the launcher leaves its class on the inbox row and in one session record', () => {
  const { root, submit } = fixture();
  const bin = mkdtempSync(join(tmpdir(), 'operator-inbox-bin-'));
  try {
    // The launcher's claude --bg path (no Herdr on PATH) starts this stand-in
    // agent; it runs the two hooks as Claude Code would, with its environment.
    const hookInput = (event: string, extra: object) =>
      JSON.stringify({
        session_id: sessionId,
        cwd: root,
        transcript_path: join(root, 'missing.jsonl'),
        hook_event_name: event,
        ...extra,
      });
    const agent = join(bin, 'successor-agent');
    const lines = ['#!/bin/sh'];
    for (const [script, payload] of [
      [restart, hookInput('SessionStart', { source: 'startup' })],
      [restart, hookInput('SessionStart', { source: 'resume' })],
      [promptHook, hookInput('UserPromptSubmit', { prompt: directive })],
    ] as const)
      lines.push(
        `printf '%s' '${payload}' | ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} >/dev/null`,
      );
    writeFileSync(agent, `${lines.join('\n')}\n`, { mode: 0o755 });
    const launched = spawnSync(
      process.execPath,
      [
        path('successor-launch.ts'),
        '--operator-token',
        '--name',
        'Next',
        '--prompt',
        'Deliver t-x',
        '--class',
        'non-delivery',
      ],
      {
        env: {
          PATH: bin,
          KRN_SUCCESSOR_AGENT: 'successor-agent',
          CLAUDE_PROJECT_DIR: root,
          ...interactive,
        },
        cwd: root,
        encoding: 'utf8',
      },
    );
    assert.equal(launched.status, 0, launched.stderr);
    const rows = readFileSync(join(root, '.krn/operator/inbox.jsonl'), 'utf8')
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'non-delivery');
    const sessions = readFileSync(
      join(root, '.krn/operator/sessions.jsonl'),
      'utf8',
    )
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session, sessionId);
    assert.equal(sessions[0].class, 'non-delivery');
    // An operator prompt in the same inbox carries no source, and only it is open.
    submit('A request typed by the operator, long enough to be a directive');
    const operator = readFileSync(
      join(root, '.krn/operator/inbox.jsonl'),
      'utf8',
    )
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line));
    assert.equal(operator[1].source, undefined);
    const open = spawnSync(process.execPath, [inbox, 'open', '--root', root], {
      encoding: 'utf8',
    }).stdout;
    assert.match(open, /typed by the operator/u);
    assert.doesNotMatch(open, /CI work like T3/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
