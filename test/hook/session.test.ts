import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { isWorkerSession } from '../../src/hook/session.ts';

test('informational hooks are silent in a worker session and speak for the lead', () => {
  assert.equal(isWorkerSession({ KRN_ROLE: 'worker' }), true);
  assert.equal(isWorkerSession({ KRN_SESSION_CLASS: 'lane' }), true);
  assert.equal(isWorkerSession({}), false);
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    cwd: '/nonexistent',
  });
  for (const hook of ['context-gauge'])
    assert.equal(
      execFileSync(
        'node',
        [new URL(`../../scripts/claude/${hook}.ts`, import.meta.url).pathname],
        {
          input: payload,
          encoding: 'utf8',
          env: { ...process.env, KRN_ROLE: 'worker' },
        },
      ),
      '',
    );
});

test('SessionStart injects the matching standards of an adopted repository and logs the exposure; a worker and a plain repository get none', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'session-standards-'));
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const record = (id: string, text: string) => ({
    id,
    type: 'standard',
    area: 'tests',
    layer: 'universal',
    audience: 'worker',
    tier: 'reflex',
    text,
    why: 'Because.',
    provenance: { origin: 'test', evidence: ['README.md'], proposals: [] },
    enforcement: { kind: 'advisory' },
    applies: { stacks: [], needs: [], paths: [], terms: [] },
    status: 'accepted',
    supersedes: [],
    recorded_at: '2026-01-01',
    valid_from: '2026-01-01',
    valid_to: null,
  });
  const start = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [
        new URL('../../scripts/claude/context-restart.ts', import.meta.url)
          .pathname,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        // A SessionStart payload as Claude Code sends it.
        input: JSON.stringify({
          session_id: 'sess-9',
          transcript_path: join(root, 't.jsonl'),
          cwd: root,
          hook_event_name: 'SessionStart',
          source: 'startup',
        }),
        env: {
          ...process.env,
          KRN_ROLE: '',
          KRN_SESSION_CLASS: '',
          CLAUDE_PROJECT_DIR: root,
          GIT_CEILING_DIRECTORIES: join(root, '..'),
          ...env,
        },
      },
    );
  const context = (out: string): string =>
    (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
  try {
    git('init', '-b', 'fix-flaky-widget');
    git(
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@e.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'x',
    );
    assert.doesNotMatch(context(start({}).stdout), /Standards for this task/u);
    mkdirSync(join(root, '.agents'));
    writeFileSync(
      join(root, '.agents/standards.json'),
      JSON.stringify([
        record(
          's-widget',
          'Flaky widget tests are fixed by removing the shared timer, never by retrying.',
        ),
        record('s-other', 'Database migrations run inside one transaction.'),
      ]),
    );
    const served = context(start({}).stdout);
    assert.match(served, /Standards for this task \(1\)/u);
    assert.match(served, /\[s-widget\]/u);
    assert.doesNotMatch(served, /s-other/u);
    const [line] = readFileSync(
      join(root, '.krn/brain/exposures.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n');
    assert.equal(JSON.parse(line ?? '{}').channel, 'session');
    assert.deepEqual(JSON.parse(line ?? '{}').served, ['s-widget']);
    assert.doesNotMatch(
      context(start({ KRN_ROLE: 'worker' }).stdout),
      /Standards for this task/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
