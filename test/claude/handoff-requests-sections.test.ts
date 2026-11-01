import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/handoff-requests.ts', import.meta.url),
);
const restartBlock = [
  '## Restart block',
  '- Verify first: `npm run check`',
  '- Task: t-abc1234',
  `- SHAs: main=${'a'.repeat(40)}`,
  '- Done when: `npm test -- test/claude/handoff-requests-sections.test.ts`',
].join('\n');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'handoff-sections-'));
  mkdirSync(join(root, 'tasks'));
  writeFileSync(join(root, 'tasks/t-abc1234.json'), '{}');
  mkdirSync(join(root, 'memory'));
  writeFileSync(join(root, 'memory/herdr-tabs.md'), 'fixture');
  const check = (body: string) => {
    const handoff = join(root, 'handoff.md');
    writeFileSync(handoff, `# Handoff\n\n${restartBlock}\n\n${body}`);
    return spawnSync(
      process.execPath,
      [script, handoff, '--root', root, '--memory', join(root, 'memory')],
      { encoding: 'utf8' },
    );
  };
  return { root, check };
}

test('an indented level-one or level-two heading ends the operator requests section', () => {
  const { root, check } = fixture();
  try {
    for (const heading of ['  ## Grants', '   # Notes', ' ## Grants ##']) {
      const result = check(
        [
          '## Operator requests',
          '- "Successor tabs in herdr": t-abc1234',
          heading,
          '- free text after the section',
          '',
        ].join('\n'),
      );
      assert.equal(result.status, 0, `${heading}\n${result.stderr}`);
      assert.match(
        result.stdout,
        /^PASS .*: 1 open operator request\(s\) recorded\n$/u,
      );
    }
    for (const body of [
      '## Operator requests\n- t-abc1234\n  ### Detail\n',
      '## Operator requests\n- t-abc1234\n  ##\n',
    ]) {
      const result = check(body);
      assert.equal(result.status, 1, body);
      assert.match(
        result.stderr,
        /not allowed in the operator requests section/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a second operator requests section is refused', () => {
  const { root, check } = fixture();
  try {
    for (const body of [
      '## Operator requests\n- t-abc1234\n\n## Grants\n- x\n\n## Operator requests\n- memory:herdr-tabs\n',
      '## Operator requests\n- none\n\n## Grants\n\n  ## Operator requests\n- t-abc1234\n',
    ]) {
      const result = check(body);
      assert.equal(result.status, 1, `${body}\n${result.stdout}`);
      assert.match(
        result.stderr,
        /:\d+: a second "## Operator requests" section is not allowed/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
