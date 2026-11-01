import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modulePath = fileURLToPath(
  new URL('../../scripts/claude/handoff-block.ts', import.meta.url),
);
const hook = fileURLToPath(
  new URL('../../scripts/claude/context-restart.ts', import.meta.url),
);
const requestsCli = fileURLToPath(
  new URL('../../scripts/claude/handoff-requests.ts', import.meta.url),
);

const validBlock = [
  '## Restart block',
  '- Verify first: `npm run check`',
  '- Task: t-abc1234',
  `- SHAs: main=${'a'.repeat(40)}, feat/work=${'b'.repeat(40)}`,
  '- Done when: `npm test -- test/claude/handoff-block.test.ts`',
].join('\n');

function validHandoff(request = '- "Find the best papers": t-abc1234') {
  return `# Handoff\n\n${validBlock}\n\n## Operator requests\n${request}\n\n## Notes\n- pointer\n`;
}

async function loadModule() {
  return import(pathToFileURL(modulePath).href).catch(() => ({}));
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'handoff-block-'));
  mkdirSync(join(root, 'tasks'));
  writeFileSync(join(root, 'tasks/t-abc1234.json'), '{}');
  return root;
}

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runHook(root: string) {
  return spawnSync(process.execPath, [hook], {
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
}

test('restart block module exports its validator before exercising fixtures', async () => {
  const block = await loadModule();
  assert.equal(typeof block.restartBlock, 'function');
  const root = repository();
  try {
    const result = block.restartBlock(validHandoff(), root);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.lines, validBlock.split('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart block validator names every missing or invalid field', async () => {
  const block = await loadModule();
  assert.equal(typeof block.restartBlock, 'function');
  const root = repository();
  try {
    const cases: [string, RegExp][] = [
      [
        validBlock.replace('- Verify first: `npm run check`\n', ''),
        /Verify first/u,
      ],
      [validBlock.replace('- Task: t-abc1234\n', ''), /Task/u],
      [validBlock.replace(/- SHAs:.*\n/u, ''), /SHAs/u],
      [
        validBlock.replace(
          '- Done when: `npm test -- test/claude/handoff-block.test.ts`',
          '',
        ),
        /Done when/u,
      ],
      [validBlock.replace('a'.repeat(40), 'abc1234'), /SHAs/u],
      [validBlock.replace('b'.repeat(40), '1234567'), /SHAs/u],
      [
        validBlock.replace(
          `main=${'a'.repeat(40)}`,
          `feat/work=${'b'.repeat(40)}`,
        ),
        /SHAs/u,
      ],
      [validBlock.replace('t-abc1234', 't-missing'), /tasks\/t-missing\.json/u],
      [
        validBlock.replace('## Restart block', '## Notes'),
        /first level-two heading/u,
      ],
      [
        validBlock.replace('## Restart block', '## restart block'),
        /Restart block section is missing/u,
      ],
      [
        validBlock.replace(
          '- Task: t-abc1234',
          'extra line\n- Task: t-abc1234',
        ),
        /exactly four/u,
      ],
      [
        validBlock.replace('npm run check', 'x'.repeat(2100)),
        /2000 characters/u,
      ],
    ];
    for (const [candidate, expected] of cases) {
      const text = `# Handoff\n\n${candidate}\n\n## Operator requests\n- none\n`;
      const result = block.restartBlock(text, root);
      assert.ok(
        result.problems.some((problem: string) => expected.test(problem)),
        `${candidate}\nExpected problem: ${expected}`,
      );
    }
    const misplaced = block.restartBlock(
      `# Handoff\n\n## Notes\ntext\n\n${validBlock}\n\n## Operator requests\n- none\n`,
      root,
    );
    assert.ok(
      misplaced.problems.some((problem: string) =>
        /first level-two heading/u.test(problem),
      ),
    );
    const unquoted = block.restartBlock(
      validHandoff('- Find the best papers: t-abc1234'),
      root,
    );
    assert.ok(
      unquoted.problems.some((problem: string) => /quote/u.test(problem)),
      JSON.stringify(unquoted.problems),
    );
    for (const request of ['- closed: answered', '- none']) {
      assert.deepEqual(
        block.restartBlock(validHandoff(request), root).problems,
        [],
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart block refuses duplicate operator request sections and SessionStart reports it', async () => {
  const block = await loadModule();
  const root = repository();
  try {
    git(root, ['init', '-b', 'fixture']);
    git(root, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    const newest = join(root, '.krn/runs/newest');
    mkdirSync(newest, { recursive: true });
    const path = join(newest, 'handoff.md');
    const handoff = `# Handoff\n\n${validBlock}\n\n## Operator requests\n- none\n\n## operator requests\n- "Continue this request": t-abc1234\n`;
    writeFileSync(path, handoff);

    const validation = block.restartBlock(handoff, root);
    const result = runHook(root);
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext;
    assert.deepEqual(
      {
        validatorRefused: validation.problems.some((problem: string) =>
          /Operator requests section/u.test(problem),
        ),
        hookReportedInvalid: context.includes(
          `Newest handoff: ${path} (no restart block:`,
        ),
        injectedBlock: context.includes('- Verify first: `npm run check`'),
      },
      {
        validatorRefused: true,
        hookReportedInvalid: true,
        injectedBlock: false,
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart block refuses a missing operator request section and SessionStart reports it', async () => {
  const block = await loadModule();
  const root = repository();
  try {
    git(root, ['init', '-b', 'fixture']);
    git(root, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    const newest = join(root, '.krn/runs/newest');
    mkdirSync(newest, { recursive: true });
    const path = join(newest, 'handoff.md');
    const handoff = `# Handoff\n\n${validBlock}\n\n## Notes\n- no requests\n`;
    writeFileSync(path, handoff);

    const validation = block.restartBlock(handoff, root);
    const result = runHook(root);
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext;
    assert.deepEqual(
      {
        validatorRefused: validation.problems.some((problem: string) =>
          /Operator requests section/u.test(problem),
        ),
        hookReportedInvalid: context.includes(
          `Newest handoff: ${path} (no restart block:`,
        ),
        injectedBlock: context.includes('- Verify first: `npm run check`'),
      },
      {
        validatorRefused: true,
        hookReportedInvalid: true,
        injectedBlock: false,
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart block size uses CRLF characters from the original text', async () => {
  const block = await loadModule();
  const root = repository();
  try {
    const commandLength = 2000 - validBlock.length + 'npm run check'.length;
    const normalizedBlock = validBlock.replace(
      'npm run check',
      'x'.repeat(commandLength),
    );
    assert.equal(normalizedBlock.length, 2000);
    const handoff = `# Handoff\r\n\r\n${normalizedBlock.replace(/\n/gu, '\r\n')}\r\n\r\n## Operator requests\r\n- none\r\n`;
    assert.ok(handoff.includes('\r\n'));

    const result = block.restartBlock(handoff, root);
    assert.ok(
      result.problems.some((problem: string) =>
        /2000 characters/u.test(problem),
      ),
      JSON.stringify(result.problems),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('handoff request CLI reports every missing restart field', () => {
  const root = repository();
  const handoff = join(root, 'handoff.md');
  try {
    writeFileSync(
      handoff,
      '# Handoff\n\n## Restart block\n\n## Operator requests\n- none\n',
    );
    const result = spawnSync(
      process.execPath,
      [requestsCli, handoff, '--root', root],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    for (const field of ['Verify first', 'Task', 'SHAs', 'Done when'])
      assert.ok(result.stderr.includes(field), `${field}: ${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SessionStart injects the newest valid restart block and requests before branch context', () => {
  const root = repository();
  try {
    git(root, ['init', '-b', 'fixture']);
    git(root, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    const runs = join(root, '.krn/runs');
    const newest = join(runs, 'newest');
    const older = join(runs, 'older');
    mkdirSync(newest, { recursive: true });
    mkdirSync(older, { recursive: true });
    const olderPath = join(older, 'handoff.md');
    const newestPath = join(newest, 'handoff.md');
    writeFileSync(
      olderPath,
      validHandoff().replace('npm run check', 'older verify'),
    );
    writeFileSync(newestPath, validHandoff());
    utimesSync(olderPath, new Date(1000), new Date(1000));
    utimesSync(newestPath, new Date(2000), new Date(2000));
    const result = runHook(root);
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext;
    const lines = context.split('\n');
    assert.match(
      lines[0],
      new RegExp(`${newestPath}.*before any other step`, 'u'),
    );
    assert.equal(lines[1], '- Verify first: `npm run check`');
    assert.ok(
      context.indexOf('## Operator requests') < context.indexOf('Branch:'),
    );
    assert.ok(
      context.indexOf('## Operator requests') > context.indexOf('- Done when:'),
    );
    assert.ok(!context.includes('older verify'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SessionStart reports an invalid block and preserves it through tail truncation', () => {
  const root = repository();
  try {
    git(root, ['init', '-b', 'fixture']);
    git(root, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    const runs = join(root, '.krn/runs');
    const newest = join(runs, 'newest');
    mkdirSync(newest, { recursive: true });
    const path = join(newest, 'handoff.md');
    writeFileSync(
      path,
      validHandoff().replace('- Task: t-abc1234', '- Task: t-missing'),
    );
    mkdirSync(join(root, '.krn/task-claims'), { recursive: true });
    for (let index = 0; index < 120; index++) {
      writeFileSync(
        join(root, '.krn/task-claims', `claim-${index}.json`),
        JSON.stringify({ id: `claim-${index}`, actor: 'x'.repeat(160) }),
      );
    }
    const invalid = runHook(root);
    assert.equal(invalid.status, 0, invalid.stderr);
    const invalidContext = JSON.parse(invalid.stdout).hookSpecificOutput
      .additionalContext;
    assert.ok(
      invalidContext.includes(`Newest handoff: ${path} (no restart block:`),
    );
    assert.ok(!invalidContext.includes('- Verify first:'));

    writeFileSync(path, validHandoff());
    const valid = runHook(root);
    assert.equal(valid.status, 0, valid.stderr);
    const validContext = JSON.parse(valid.stdout).hookSpecificOutput
      .additionalContext;
    assert.ok(
      validContext.startsWith(
        `Handoff: ${path}; run \`npm run check\` before any other step.\n- Verify first: `,
      ),
    );
    assert.ok(
      validContext.includes(validBlock.split('\n').slice(1).join('\n')),
    );
    assert.ok(validContext.length <= 8000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
