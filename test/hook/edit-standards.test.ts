// KRN-12: the real `krn adopt` and `krn hook edit` entries against a fresh adopted PHP repository, fed the
// verbatim PreToolUse payloads Claude Code sent for an Edit and a Write of two PHP files in one session
// (fixtures/pretooluse-edit-write-php.jsonl): the first PHP edit brings the PHP-scoped records and logs
// an edit exposure, the second PHP edit of the session adds nothing.
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
import { editedFile, fileKind } from '../../src/hook/edit-standards.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const capture = readFileSync(
  new URL('fixtures/pretooluse-edit-write-php.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .slice(0, -1);
/** The directory the captured session ran in; each payload is replayed against a fresh repository. */
const capturedRoot = '/mnt/storage/tmp/krn/edit-capture';

function run(cwd: string, command: string, args: string[], input = '') {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    input,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
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
  return root;
}

const replay = (root: string, line: string) =>
  run(
    root,
    process.execPath,
    [cli, 'hook', 'edit'],
    line.split(capturedRoot).join(root),
  );

test('the first PHP edit of a session brings the PHP records, the second adds nothing', () => {
  const root = adoptedPhp();
  try {
    const settings = JSON.parse(
      readFileSync(join(root, '.claude/settings.json'), 'utf8'),
    );
    assert.ok(
      settings.hooks.PreToolUse.some(
        (entry: { matcher: string; hooks: { command: string }[] }) =>
          entry.matcher === 'Edit|Write|MultiEdit' &&
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
    assert.match(context, /^Standards for editing src\/a\.php \(\d+\):/u);
    assert.match(context, /\[s-php-/u);
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
    assert.equal(second.stdout, '');
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
