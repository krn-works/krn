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
    const bare = run(
      root,
      process.execPath,
      [cli, 'hook', 'session'],
      session(root, 'sess-bare'),
    );
    assert.equal(bare.status, 0, bare.stderr);
    assert.doesNotMatch(
      bare.stdout,
      /Standards for this task/u,
      'a session with no claimed task is served no standards',
    );
    const advisory = join(root, '.agents/standards.json');
    writeFileSync(
      advisory,
      JSON.stringify([
        ...(JSON.parse(readFileSync(advisory, 'utf8')) as unknown[]),
        {
          id: 's-commit-after-linter',
          type: 'standard',
          area: 'tests',
          layer: 'universal',
          audience: 'worker',
          tier: 'reflex',
          text: 'Commit a change only after the linter and the tests pass, with a Ticket trailer.',
          why: 'A red commit costs a CI round.',
          provenance: { origin: 'test', evidence: ['index.js'], proposals: [] },
          enforcement: { kind: 'advisory' },
          applies: { stacks: [], needs: [], paths: [], terms: [] },
          status: 'accepted',
          supersedes: [],
          recorded_at: '2026-01-01',
          valid_from: '2026-01-01',
          valid_to: null,
        },
      ]),
    );
    mkdirSync(join(root, 'tasks'));
    mkdirSync(join(root, '.krn/task-claims'), { recursive: true });
    writeFileSync(
      join(root, 'tasks/t-fix.json'),
      JSON.stringify({
        id: 't-fix',
        status: 'open',
        title: 'Commit a change after the linter and the tests pass',
        body: ['Outcome: a commit with a Ticket trailer\nFiles: index.js'],
      }),
    );
    writeFileSync(
      join(root, '.krn/task-claims/t-fix.json'),
      JSON.stringify({
        id: 't-fix',
        actor: 'lead',
        worktree: root,
        branch: 'work',
        claimed: '2026-01-01T00:00:00.000Z',
        reason: null,
      }),
    );
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
      /^Standards for this task \((\d+); at most 3 records, retrieval confidence >= 2\):/u,
    );
    assert.match(context.additionalContext, /- \[[sr]-[a-z0-9-]+\]/u);
    rmSync(join(root, 'tasks'), { recursive: true, force: true });

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
      {
        KRN_SESSION_CLASS: 'lane',
        KRN_LANE: 'x',
        KRN_TEST_FIRST: '0',
        KRN_ACCEPTANCE_CLAUSES: '0',
      },
    );
    assert.equal(stop.status, 2, stop.stderr);
    assert.match(stop.stderr, /s-no-todo-markers \(floor\)/u);
    assert.match(stop.stderr, /why: A marker records work nobody owns\./u);

    const effect = run(root, process.execPath, [cli, 'standards', 'effect']);
    assert.equal(effect.status, 0, effect.stderr);
    assert.match(effect.stdout, /^effect: 2 run\(s\), \d+ record\(s\)/u);
    // A refusal is no served exposure: the record is not counted as served.
    assert.doesNotMatch(effect.stdout, /^s-no-todo-markers: served/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const tail = fileURLToPath(
  new URL(
    '../fixtures/session-resume/lead-transcript-tail.jsonl',
    import.meta.url,
  ),
);

const resumed = (root: string, transcript: string, source = 'resume') =>
  JSON.stringify({
    session_id: 'sess-resume',
    transcript_path: transcript,
    hook_event_name: 'SessionStart',
    source,
    cwd: root,
  });

const context = (stdout: string): string =>
  (
    JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext: string };
    }
  ).hookSpecificOutput.additionalContext;

test('a resumed lead session with no claimed task is served the lead record its transcript tail calls for, within the cap', () => {
  const root = adopted();
  try {
    const records = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../.agents/records.json', import.meta.url)),
        'utf8',
      ),
    ) as { id: string }[];
    writeFileSync(
      join(root, '.agents/records.json'),
      JSON.stringify(
        records.filter((record) =>
          [
            'r-verify-premise-before-cause',
            'r-tracker-owner',
            'r-bounded-context',
            'r-trailer',
          ].includes(record.id),
        ),
      ),
    );
    const contract = join(root, 'krn.json');
    writeFileSync(
      contract,
      JSON.stringify({
        ...(JSON.parse(readFileSync(contract, 'utf8')) as object),
        conventions: '.agents/records.json',
      }),
    );
    for (const args of [
      ['add', '-A'],
      ['commit', '-q', '-m', 'records'],
    ])
      assert.equal(run(root, 'git', args).status, 0);

    const resume = run(
      root,
      process.execPath,
      [cli, 'hook', 'session-start'],
      resumed(root, tail),
    );
    assert.equal(resume.status, 0, resume.stderr);
    const text = context(resume.stdout);
    assert.match(
      text,
      /Standards for this session \((\d); at most 3 records, retrieval confidence >= 2\):/u,
    );
    assert.match(text, /- \[r-verify-premise-before-cause\]/u);
    assert.ok((text.match(/^- \[r-[a-z-]+\]/gmu) ?? []).length <= 3);

    const fresh = run(
      root,
      process.execPath,
      [cli, 'hook', 'session-start'],
      resumed(root, tail, 'startup'),
    );
    assert.doesNotMatch(context(fresh.stdout), /Standards for this/u);

    const worker = run(
      root,
      process.execPath,
      [cli, 'hook', 'session-start'],
      resumed(root, tail),
      { KRN_SESSION_CLASS: 'lane' },
    );
    assert.doesNotMatch(context(worker.stdout), /Standards for this/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
