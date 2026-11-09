import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/context-restart.ts', import.meta.url),
);

test('restart hook emits bounded JSON with branch, open claims and newest handoff only', () => {
  assert.ok(existsSync(script), 'restart script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-restart-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['init', '-b', 'fixture']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    mkdirSync(join(root, '.krn/task-claims'), { recursive: true });
    writeFileSync(
      join(root, '.krn/task-claims/claim.json'),
      '{"id":"fixture-claim","actor":"lead"}',
    );
    writeFileSync(
      join(root, '.krn/task-claims/stale.json'),
      '{"id":"stale-claim","actor":"lead"}',
    );
    writeFileSync(join(root, '.krn/task-claims/broken.json'), '{');
    mkdirSync(join(root, 'tasks'));
    writeFileSync(
      join(root, 'tasks/stale-claim.json'),
      '{"id":"stale-claim","status":"closed"}',
    );
    writeFileSync(
      join(root, 'tasks/fixture-claim.json'),
      '{"id":"fixture-claim","status":"open"}',
    );
    mkdirSync(join(root, '.krn/runs/delivery-loop/outcome'), {
      recursive: true,
    });
    writeFileSync(
      join(root, '.krn/runs/delivery-loop/outcome/handoff.md'),
      'pointer only',
    );
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        GIT_CEILING_DIRECTORIES: dirname(root),
      },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: join(root, 'transcript'),
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.length <= 8000);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.hookEventName, 'SessionStart');
    for (const text of [
      'fixture',
      git(['rev-parse', '--short', 'HEAD']),
      'fixture-claim',
      'handoff.md',
    ])
      assert.ok(output.additionalContext.includes(text), text);
    assert.ok(
      !output.additionalContext.includes('Rule:'),
      'static rules live in CLAUDE.md',
    );
    assert.ok(output.additionalContext.length < 500);
    assert.ok(
      !output.additionalContext.includes('stale-claim'),
      'claims on closed tasks are stale',
    );
    const linked = join(root, 'linked');
    git(['worktree', 'add', '--detach', linked, 'HEAD']);
    const resumed = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: linked },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: 'unused',
        hook_event_name: 'SessionStart',
        source: 'compact',
      }),
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.ok(resumed.stdout.length <= 8000);
    const resumedContext = JSON.parse(resumed.stdout).hookSpecificOutput
      .additionalContext;
    assert.match(resumedContext, /fixture-claim/u);
    assert.doesNotMatch(
      resumedContext,
      /Identifiers before compaction/u,
      'an unreadable transcript degrades to no index block',
    );
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(
      transcript,
      [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'Read',
                input: { file_path: `${linked}/scripts/claude/gauge.ts` },
              },
            ],
          },
        },
        {
          type: 'system',
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );
    const compacted = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: linked },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: transcript,
        hook_event_name: 'SessionStart',
        source: 'compact',
      }),
    });
    assert.equal(compacted.status, 0, compacted.stderr);
    assert.match(
      JSON.parse(compacted.stdout).hookSpecificOutput.additionalContext,
      /Identifiers before compaction[^\n]*\n- Paths: scripts\/claude\/gauge\.ts/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart hook exits silently outside git', () => {
  assert.ok(existsSync(script), 'restart script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-restart-'));
  try {
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        GIT_CEILING_DIRECTORIES: dirname(root),
      },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: 'missing',
        hook_event_name: 'SessionStart',
        source: 'resume',
      }),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart hook serves the clear source and rejects unknown ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-restart-'));
  try {
    const run = (source: string) =>
      spawnSync(process.execPath, [script], {
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: root,
          GIT_CEILING_DIRECTORIES: dirname(root),
        },
        encoding: 'utf8',
        input: JSON.stringify({
          session_id: 'session',
          transcript_path: join(root, 'transcript.jsonl'),
          cwd: root,
          hook_event_name: 'SessionStart',
          source,
        }),
      });
    for (const args of [
      ['init', '-b', 'fixture'],
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'x',
      ],
    ])
      spawnSync('git', args, { cwd: root });
    assert.match(run('clear').stdout, /"additionalContext":"Branch: fixture/u);
    assert.equal(run('bogus').stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart hook injects one consolidated block from the newest handoff within its budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-restart-block-'));
  try {
    for (const args of [
      ['init', '-b', 'fixture'],
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ],
    ])
      assert.equal(
        spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status,
        0,
      );
    mkdirSync(join(root, '.krn/runs/outcome'), { recursive: true });
    const request = 'Never drop this operator request: t-abc1234';
    writeFileSync(
      join(root, '.krn/runs/outcome/handoff.md'),
      [
        '# Handoff',
        '',
        '## Resume',
        '- Task: t-abc1234',
        '- SHAs: 5e1ce47abc',
        '- Verify: `npm run fast`',
        '',
        '## Priorities',
        'x'.repeat(20000),
        '',
        '## Operator requests',
        `- ${request}`,
        '',
      ].join('\n'),
    );
    const result = spawnSync(process.execPath, [script], {
      // SessionStart stays fast: a slow hook is killed and fails below.
      timeout: 5_000,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        GIT_CEILING_DIRECTORIES: dirname(root),
      },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: join(root, 'transcript'),
        hook_event_name: 'SessionStart',
        source: 'clear',
      }),
    });
    assert.equal(result.error, undefined, 'SessionStart stays fast');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.length <= 8000);
    const context: string = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext;
    for (const text of [
      'run the Verify command before any other step',
      '- Task: t-abc1234',
      '- SHAs: 5e1ce47abc',
      '- Verify: `npm run fast`',
      request,
    ])
      assert.ok(context.includes(text), text);
    assert.ok(!context.includes('xxxxx'), 'other sections stay out');
    assert.ok(context.length < 1000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart hook injects the resume task record so startup needs no cat of tasks/<id>.json', async () => {
  const { taskBrief } = await import('../../scripts/claude/context-restart.ts');
  const root = mkdtempSync(join(tmpdir(), 'context-restart-task-'));
  try {
    mkdirSync(join(root, 'tasks'));
    writeFileSync(
      join(root, 'tasks/t-abc1234.json'),
      JSON.stringify({
        id: 't-abc1234',
        status: 'open',
        priority: 1,
        title: 'Fixture title',
        body: ['Outcome: fixture outcome.', 'y'.repeat(5000)],
      }),
    );
    const handoff = '# Handoff\n\n## Resume\n- Task: t-abc1234\n';
    const brief = taskBrief(root, handoff) ?? '';
    assert.ok(
      brief.startsWith(
        'Task t-abc1234 (open, P1): Fixture title\nOutcome: fixture outcome.',
      ),
      brief.slice(0, 80),
    );
    assert.ok(brief.length <= 1500, 'bounded');
    assert.equal(taskBrief(root, '## Resume\n- Task: t-zzz9999\n'), undefined);
    assert.equal(taskBrief(root, '# no resume section'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
