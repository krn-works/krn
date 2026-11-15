// KRN-12: the real `krn adopt` and `krn hook` entries against a fresh adopted repository, with the
// payloads Claude Code sends: SessionStart serves the brain's standards, a seeded violation is
// taught at Stop, and `krn standards effect` counts both from the exposure log.
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

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function run(
  cwd: string,
  command: string,
  args: string[],
  input = '',
  env: Record<string, string> = {},
) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    input,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
  });
}

function adopted(): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-session-'));
  const git = (...args: string[]) => {
    const out = run(root, 'git', args);
    assert.equal(out.status, 0, out.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  mkdirSync(join(root, 'test'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fresh', scripts: { test: 'node --test' } }),
  );
  writeFileSync(join(root, 'index.js'), 'exports.a = 1;\n');
  writeFileSync(
    join(root, 'test/a.test.js'),
    "require('node:test')('a', () => require('../index.js'));\n",
  );
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  const adopt = run(root, process.execPath, [cli, 'adopt', root]);
  assert.equal(adopt.status, 0, adopt.stderr);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: adopt krn');
  git('checkout', '-q', '-b', 'work');
  return root;
}

const session = (root: string, id: string) =>
  JSON.stringify({
    session_id: id,
    transcript_path: join(root, 'transcript.jsonl'),
    hook_event_name: 'SessionStart',
    source: 'startup',
    cwd: root,
  });

test('an adopted fresh repository serves the brain standards at session start, teaches a seeded violation at Stop and shows both in standards effect', () => {
  const root = adopted();
  try {
    const start = run(
      root,
      process.execPath,
      [cli, 'hook', 'session'],
      session(root, 'sess-start'),
    );
    assert.equal(start.status, 0, start.stderr);
    const context = (
      JSON.parse(start.stdout) as {
        hookSpecificOutput: {
          hookEventName: string;
          additionalContext: string;
        };
      }
    ).hookSpecificOutput;
    assert.equal(context.hookEventName, 'SessionStart');
    assert.match(
      context.additionalContext,
      /^Standards for this task \(\d+\):/u,
    );
    assert.match(context.additionalContext, /- \[s-[a-z-]+\]/u);

    const worker = run(
      root,
      process.execPath,
      [cli, 'hook', 'session'],
      session(root, 'sess-worker'),
      { KRN_SESSION_CLASS: 'lane' },
    );
    assert.equal(worker.stdout, '', 'a worker session is served nothing');

    const standards = join(root, '.agents/standards.json');
    const seeded = JSON.parse(readFileSync(standards, 'utf8')) as unknown[];
    seeded.push({
      id: 's-no-todo-markers',
      type: 'standard',
      area: 'tests',
      layer: 'universal',
      audience: 'worker',
      tier: 'floor',
      text: 'Source carries no TODO marker.',
      why: 'A marker records work nobody owns.',
      provenance: { origin: 'test', evidence: ['index.js'], proposals: [] },
      enforcement: { kind: 'command', run: '! grep -rq TODO index.js' },
      applies: { stacks: [], needs: [], paths: [], terms: [] },
      status: 'accepted',
      supersedes: [],
      recorded_at: '2026-01-01',
      valid_from: '2026-01-01',
      valid_to: null,
    });
    writeFileSync(standards, JSON.stringify(seeded));
    writeFileSync(join(root, 'index.js'), 'exports.a = 2; // TODO\n');
    for (const args of [
      ['add', '-A'],
      ['commit', '-q', '-m', 'change'],
    ])
      assert.equal(run(root, 'git', args).status, 0);
    const stop = run(
      root,
      process.execPath,
      [cli, 'hook', 'stop'],
      JSON.stringify({ cwd: root, session_id: 'sess-stop' }),
      { KRN_SESSION_CLASS: 'lane', KRN_LANE: 'x' },
    );
    assert.equal(stop.status, 2, stop.stderr);
    assert.match(stop.stderr, /s-no-todo-markers \(floor\)/u);
    assert.match(stop.stderr, /why: A marker records work nobody owns\./u);

    const effect = run(root, process.execPath, [cli, 'standards', 'effect']);
    assert.equal(effect.status, 0, effect.stderr);
    assert.match(effect.stdout, /^effect: 2 run\(s\), \d+ record\(s\)/u);
    assert.match(
      effect.stdout,
      /^s-no-todo-markers: served 1 \(ok 0%, followed 0, violated 1\)/mu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
