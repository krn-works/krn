// KRN-12: the real `krn adopt` and `krn hook edit` entries against a fresh adopted PHP repository, fed the
// verbatim PreToolUse payloads Claude Code sent for an Edit and a Write of two PHP files in one session
// (fixtures/pretooluse-edit-write-php.jsonl, host paths redacted): the first PHP edit brings the PHP-scoped records and logs
// an edit exposure, the second adds only records not yet shown.
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
import { editStandardsCommand } from '../../src/adopt/stop-hook.ts';
import { ingestCandidate } from '../../src/brain/candidate-ingest.ts';
import {
  appendExposure,
  readExposures,
  servedExposure,
} from '../../src/brain/exposures.ts';
import { heldOut } from '../../src/brain/worker-packet.ts';
import { ruleViolations } from '../../src/hook/edit-rules.ts';
import {
  commandFiles,
  editContext,
  editedFile,
  editRecordsFor,
  fileKind,
} from '../../src/hook/edit-standards.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const capture = readFileSync(
  new URL('fixtures/pretooluse-edit-write-php.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .slice(0, -1);
/** The directory the captured session ran in, redacted to the capture placeholder (test/fixtures/README.md); each payload is replayed against a fresh repository. */
const capturedRoot = '/work/repo';
/** The verbatim PreToolUse payload of a headless session that edited src/a.php through a python one-liner in Bash. */
const bashCapture = readFileSync(
  new URL('fixtures/pretooluse-bash-php.jsonl', import.meta.url),
  'utf8',
).trim();

/** The task a PHP session works on: its words are what the edit moment's confidence gate matches the PHP records against. */
const phpTask = 't-phpedit';
const phpTaskText = 'php composer error catch autoload';

function run(cwd: string, command: string, args: string[], input = '') {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    input,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, KRN_TASK: phpTask },
  });
}

function adoptedPhp(): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-edit-'));
  const git = (...args: string[]) => {
    const out = run(root, 'git', args);
    assert.equal(out.status, 0, out.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'composer.json'), '{"name":"a/b"}\n');
  writeFileSync(join(root, 'src/a.php'), '<?php\necho "x";\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  const adopt = run(root, process.execPath, [cli, 'adopt', root]);
  assert.equal(adopt.status, 0, adopt.stderr);
  mkdirSync(join(root, 'tasks'), { recursive: true });
  writeFileSync(
    join(root, `tasks/${phpTask}.json`),
    JSON.stringify({
      id: phpTask,
      status: 'open',
      title: phpTaskText,
      body: [`Outcome: ${phpTaskText}`],
    }) + '\n',
  );
  return root;
}

const replay = (root: string, line: string) =>
  run(
    root,
    process.execPath,
    [cli, 'hook', 'edit'],
    line.split(capturedRoot).join(root),
  );

test('the first PHP edit of a session brings the PHP records, the second adds only records not yet shown', () => {
  const root = adoptedPhp();
  try {
    const settings = JSON.parse(
      readFileSync(join(root, '.claude/settings.json'), 'utf8'),
    );
    assert.ok(
      settings.hooks.PreToolUse.some(
        (entry: { matcher: string; hooks: { command: string }[] }) =>
          entry.matcher === 'Edit|Write|MultiEdit|Bash' &&
          entry.hooks.some((hook) => hook.command === editStandardsCommand),
      ),
      'adopt installs the edit hook',
    );
    const [edit = '', write = ''] = capture;
    const first = replay(root, edit);
    assert.equal(first.status, 0, first.stderr);
    const output = JSON.parse(first.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    const context: string = output.hookSpecificOutput.additionalContext;
    assert.match(
      context,
      /^Standards for editing src\/a\.php \((\d+); at most 3 records, retrieval confidence >= 2\):/u,
    );
    assert.match(context, /\[s-php-/u);
    assert.ok(
      (context.match(/\n- \[/gu)?.length ?? 0) <= 3,
      'the edit block serves at most the cap',
    );
    const exposures = readFileSync(
      join(root, '.krn/brain/exposures.jsonl'),
      'utf8',
    )
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line));
    const logged = exposures.filter((e) => e.channel === 'edit');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].scope, 'php');
    assert.ok(logged[0].served.length > 0);
    const second = replay(root, write);
    assert.equal(second.status, 0, second.stderr);
    const ids = (text: string) =>
      [...text.matchAll(/\[(s-[^\]]+)\]/gu)].map((m) => m[1]);
    const later = second.stdout
      ? ids(JSON.parse(second.stdout).hookSpecificOutput.additionalContext)
      : [];
    assert.ok(
      later.every((id) => !ids(context).includes(id)),
      'the second PHP edit repeats no record',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session with no claimed task still gets the PHP records its edit text matches', () => {
  const root = adoptedPhp();
  try {
    rmSync(join(root, `tasks/${phpTask}.json`));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
    };
    delete env.KRN_TASK;
    const [edit = ''] = capture;
    const first = spawnSync(process.execPath, [cli, 'hook', 'edit'], {
      cwd: root,
      encoding: 'utf8',
      input: edit.split(capturedRoot).join(root),
      env,
    });
    assert.equal(first.status, 0, first.stderr);
    assert.match(
      JSON.parse(first.stdout).hookSpecificOutput.additionalContext,
      /^Standards for editing src\/a\.php \((\d+); at most 3 records, retrieval confidence >= 2\):\n- \[s-php-/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lane that edits PHP through a Bash one-liner gets the PHP records and logs an edit exposure', () => {
  const root = adoptedPhp();
  try {
    const first = replay(root, bashCapture);
    assert.equal(first.status, 0, first.stderr);
    const context: string = JSON.parse(first.stdout).hookSpecificOutput
      .additionalContext;
    assert.match(
      context,
      /^Standards for editing src\/a\.php \((\d+); at most 3 records, retrieval confidence >= 2\):/u,
    );
    const logged = readFileSync(
      join(root, '.krn/brain/exposures.jsonl'),
      'utf8',
    )
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line))
      .filter((e) => e.channel === 'edit');
    assert.deepEqual(
      logged.map((e) => e.scope),
      ['php'],
    );
    const again = replay(root, bashCapture);
    const repeated = again.stdout
      ? [
          ...JSON.parse(
            again.stdout,
          ).hookSpecificOutput.additionalContext.matchAll(/\[(s-[^\]]+)\]/gu),
        ]
          .map((m) => m[1])
          .filter((id) => context.includes(`[${id}]`))
      : [];
    assert.deepEqual(repeated, [], 'the second PHP command repeats no record');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adopt over an earlier adoption widens the edit hook matcher to Bash', () => {
  const root = adoptedPhp();
  try {
    const path = join(root, '.claude/settings.json');
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    for (const entry of settings.hooks.PreToolUse)
      if (entry.hooks[0].command === editStandardsCommand)
        entry.matcher = 'Edit|Write|MultiEdit';
    writeFileSync(path, JSON.stringify(settings, null, 2));
    run(root, 'git', ['commit', '-qam', 'old matcher']);
    const refresh = run(root, process.execPath, [
      cli,
      'adopt',
      root,
      '--refresh',
    ]);
    assert.equal(refresh.status, 0, refresh.stderr);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    const edit = after.hooks.PreToolUse.filter(
      (entry: { hooks: { command: string }[] }) =>
        entry.hooks.some((hook) => hook.command === editStandardsCommand),
    );
    assert.deepEqual(
      edit.map((entry: { matcher: string }) => entry.matcher),
      ['Edit|Write|MultiEdit|Bash'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Bash command names the repository files it touches, not its words or outside paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-edit-words-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.php'), '<?php\n');
    writeFileSync(join(root, 'README.md'), 'x\n');
    assert.deepEqual(
      commandFiles(root, {
        cwd: root,
        tool_input: {
          command: `python3 -c "p='src/a.php'; s=open(p).read()"; cat README.md src/a.php /etc/hosts.txt ../x.php; touch src/new.go notes.tmp`,
        },
      }),
      ['src/a.php', 'README.md', 'src/new.go'],
    );
    assert.deepEqual(
      commandFiles(root, { tool_input: { file_path: 'a' } }),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Bash payload or a file outside the project is not an edit', () => {
  assert.equal(
    editedFile('/r', { tool_input: { command: 'ls' }, cwd: '/r' }),
    undefined,
  );
  assert.equal(
    editedFile('/r', { tool_input: { file_path: '/elsewhere/a.php' } }),
    undefined,
  );
  assert.equal(
    editedFile('/r', { tool_input: { file_path: '/r/src/a.php' } }),
    'src/a.php',
  );
});

test('a file kind is its stack, else its extension, else its name', () => {
  assert.equal(fileKind('src/a.php'), 'php');
  assert.equal(fileKind('web/app/themes/t/style.CSS'), '*.css');
  assert.equal(fileKind('Makefile'), 'Makefile');
});

test('an earlier edit exposure of a kind hides only the records it served, never later rules of the kind', () => {
  const root = adoptedPhp();
  try {
    const ids = (text: string | undefined) =>
      [...(text ?? '').matchAll(/\[(s-[^\]]+)\]/gu)].map((m) => m[1] ?? '');
    const all = ids(
      editContext(
        root,
        root,
        'probe',
        'src/a.php',
        undefined,
        undefined,
        phpTaskText,
      ),
    );
    assert.ok(all.length > 1, 'the PHP kind has several records');
    const [first = ''] = all;
    appendExposure(root, {
      ...servedExposure('session', 'edit', [first]),
      scope: 'php',
    });
    const later = ids(
      editContext(
        root,
        root,
        'session',
        'src/a.php',
        undefined,
        undefined,
        phpTaskText,
      ),
    );
    assert.ok(!later.includes(first), 'the served record is not repeated');
    assert.ok(later.length > 0, 'later rules of the kind are still printed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two sessions of one task get the same holdout arm', () => {
  const root = adoptedPhp();
  try {
    const arms = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map(
      (session) => {
        const text = editContext(
          root,
          root,
          session,
          'src/a.php',
          undefined,
          't-aaaaaaa',
          phpTaskText,
        );
        const withheld = readExposures(root).find(
          (exposure) => exposure.run === session,
        )?.withheld;
        return `${text}|${withheld?.join(',')}`;
      },
    );
    assert.equal(
      new Set(arms).size,
      1,
      'every session of the task shares an arm',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Built from parts so this file does not itself trip the clock and timeout rules it seeds.
const clock = ['Date', 'now()'].join('.');
const option = ['time', 'out'].join('');

test('an edit that writes a wall-clock assertion into a test file prints the violation in the hook output', () => {
  const root = adoptedPhp();
  try {
    const template = JSON.parse(capture[0] ?? '{}');
    const payload = {
      ...template,
      tool_input: {
        file_path: `${capturedRoot}/test/timing.test.ts`,
        old_string: 'x',
        new_string: `const started = ${clock};\nassert.ok(${clock} - started < 2000);`,
      },
    };
    const result = replay(root, JSON.stringify(payload));
    assert.equal(result.status, 0, result.stderr);
    const context: string = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext;
    assert.match(
      context,
      /Rule violations in this edit:\ntest\/timing\.test\.ts:2 wall-clock delta/u,
    );
    const clean = replay(
      root,
      JSON.stringify({
        ...payload,
        tool_input: { ...payload.tool_input, new_string: 'assert.ok(true);' },
      }),
    );
    assert.doesNotMatch(clean.stdout, /Rule violations/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the static edit rules flag a per-test timeout and pass ordinary test text', () => {
  assert.deepEqual(
    ruleViolations(
      'test/a.test.ts',
      `test('slow', { ${option}: 5000 }, () => {});`,
    ),
    [
      'test/a.test.ts:1 per-test timeout (test/rules/test-hygiene.test.mjs); the runner ceiling bounds every test',
    ],
  );
  assert.deepEqual(ruleViolations('src/a.ts', `${clock} - started`), []);
  assert.deepEqual(ruleViolations('test/a.test.ts', 'assert.ok(1);'), []);
});

const gateDay = '2026-11-19';
const gateTask = 'tighten cache invalidation handler retries';
const gateFile = 'src/cache.zzz';

/** A record of the scoped kind (`src/**` files of a kind no stack owns, so no pack record joins the pool) with the given text. */
const scopedRecord = (id: string, text: string) => ({
  id,
  type: 'standard',
  text,
  provenance: { origin: 'test' },
  status: 'accepted',
  recorded_at: gateDay,
  valid_from: gateDay,
  valid_to: null,
  applies: { paths: ['src/**/*.zzz'] },
});

function gatedRepository(records: object[]): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-edit-gate-'));
  mkdirSync(join(root, '.agents'));
  writeFileSync(
    join(root, '.agents/standards.json'),
    JSON.stringify(records, null, 2),
  );
  return root;
}

/** The ids of the edit block for one edit of the gate file, under a holdout key that withholds none of `ids`. */
function servedIds(root: string, ids: string[]): string[] {
  const key =
    Array.from({ length: 200 }, (_, n) => `key-${n}`).find((candidate) =>
      ids.every((id) => !heldOut(candidate, id)),
    ) ?? '';
  assert.notEqual(key, '', 'a holdout key withholds none of the records');
  const block = editContext(
    root,
    root,
    `session-${key}`,
    gateFile,
    gateDay,
    key,
    gateTask,
  );
  return [...(block ?? '').matchAll(/^- \[([^\]]+)\]/gmu)].map(
    (m) => m[1] ?? '',
  );
}

test('the edit moment serves only the scoped records that pass the confidence threshold, at most 3', () => {
  const strong = [
    scopedRecord('r-one', 'Bound cache invalidation retries.'),
    scopedRecord('r-two', 'Name the handler that cache invalidation calls.'),
    scopedRecord('r-three', 'Tighten every retries loop in a handler.'),
  ];
  const weak = [
    scopedRecord('r-weak-one', 'Keep cache keys short.'),
    scopedRecord('r-weak-two', 'Retries need a backoff.'),
  ];
  const root = gatedRepository([...weak, ...strong]);
  try {
    assert.deepEqual(
      servedIds(
        root,
        [...strong, ...weak].map((r) => r.id),
      ).sort(),
      ['r-one', 'r-three', 'r-two'],
      '5 scope matches, 2 below the threshold: the 3 that pass are served',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const crowded = gatedRepository(
    ['a', 'b', 'c', 'd'].map((n) =>
      scopedRecord(`r-${n}`, `Cache invalidation handler rule ${n}.`),
    ),
  );
  try {
    const ids = ['a', 'b', 'c', 'd'].map((n) => `r-${n}`);
    assert.equal(servedIds(crowded, ids).length, 3, 'the cap still binds');
  } finally {
    rmSync(crowded, { recursive: true, force: true });
  }
});

test('when every scoped record is below the confidence threshold the edit moment serves none', () => {
  const root = gatedRepository([
    scopedRecord('r-weak-one', 'Keep cache keys short.'),
    scopedRecord('r-weak-two', 'Retries need a backoff.'),
    scopedRecord('r-weak-three', 'Cache entries expire.'),
    scopedRecord('r-weak-four', 'Retries are bounded.'),
    scopedRecord('r-unrelated', 'Prefer named exports.'),
  ]);
  try {
    assert.deepEqual(editRecordsFor(root, gateFile, gateDay, gateTask), []);
    assert.equal(
      editContext(root, root, 'session', gateFile, gateDay, 'key', gateTask),
      undefined,
    );
    assert.deepEqual(editRecordsFor(root, gateFile, gateDay, ''), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A repository whose only record is the trial record of an ingested research candidate with the given text. */
function candidateRepository(id: string, text: string): string {
  const root = gatedRepository([]);
  writeFileSync(join(root, '.agents/records.json'), '[]\n');
  writeFileSync(
    join(root, 'krn.json'),
    '{ "conventions": ".agents/records.json" }\n',
  );
  const file = join(root, `${id}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      schema: 'krn.candidate/v1',
      id,
      source: {
        url: 'https://arxiv.org/abs/2601.00001',
        quote: 'q',
        sha256: 'abc',
      },
      pillar: 'recall',
      claim: 'A claim.',
      record_draft: {
        ...scopedRecord(`r-${id}`, text),
        status: 'trial',
        provenance: { origin: 'https://arxiv.org/abs/2601.00001' },
      },
      experiment: {
        population: 'cases',
        metric: 'first-push-green',
        predicted_delta: 0.05,
        min_n: 20,
      },
      expires: '2027-11-19',
      motivated_by: 'case failed',
    }),
  );
  ingestCandidate(root, file, gateDay);
  return root;
}

test('a research candidate with no evidence_kind is gated like any other record', () => {
  const root = candidateRepository('c-one-word', 'Keep cache keys short.');
  try {
    const kept = JSON.parse(
      readFileSync(join(root, '.agents/records.json'), 'utf8'),
    )[0];
    assert.equal(kept.evidence_kind, undefined, 'no evidence_kind');
    assert.deepEqual(
      editRecordsFor(root, gateFile, gateDay, gateTask),
      [],
      'a one-word match is withheld',
    );
    assert.equal(
      editContext(root, root, 'session', gateFile, gateDay, 'key', gateTask),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const strong = candidateRepository(
    'c-two-words',
    'Bound cache invalidation retries.',
  );
  try {
    assert.deepEqual(
      editRecordsFor(strong, gateFile, gateDay, gateTask).map((r) => r.id),
      ['r-c-two-words'],
      'a two-word match is served',
    );
  } finally {
    rmSync(strong, { recursive: true, force: true });
  }
});
