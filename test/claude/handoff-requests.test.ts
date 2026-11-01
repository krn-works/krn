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

const script = fileURLToPath(
  new URL('../../scripts/claude/handoff-requests.ts', import.meta.url),
);
const skill = fileURLToPath(
  new URL('../../.agents/skills/krn-handoff/SKILL.md', import.meta.url),
);
const restartBlock = [
  '## Restart block',
  '- Verify first: `npm run check`',
  '- Task: t-abc1234',
  `- SHAs: main=${'a'.repeat(40)}`,
  '- Done when: `npm test -- test/claude/handoff-requests.test.ts`',
].join('\n');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'handoff-requests-'));
  mkdirSync(join(root, 'tasks'));
  writeFileSync(join(root, 'tasks/t-abc1234.json'), '{}');
  mkdirSync(join(root, 'memory'));
  writeFileSync(join(root, 'memory/herdr-tabs.md'), 'fixture');
  mkdirSync(join(root, 'tasks/t-dir0000.json'));
  mkdirSync(join(root, 'memory/dir.md'));
  const check = (
    body: string,
    extra: string[] = [],
    header = '# Handoff\n\n',
  ) => {
    const handoff = join(root, 'handoff.md');
    writeFileSync(handoff, `${header}${restartBlock}\n\n${body}`);
    return spawnSync(
      process.execPath,
      [
        script,
        handoff,
        '--root',
        root,
        '--memory',
        join(root, 'memory'),
        ...extra,
      ],
      { encoding: 'utf8' },
    );
  };
  return { root, check };
}

test('krn-handoff runs the operator-request check on every handoff', () => {
  assert.ok(existsSync(script), 'handoff request check exists');
  const text = readFileSync(skill, 'utf8');
  assert.match(text, /## Operator requests/u);
  assert.match(text, /node scripts\/claude\/handoff-requests\.ts /u);
});

test('handoff check passes when every request has a task, memory entry or close', () => {
  assert.ok(existsSync(script), 'handoff request check exists');
  const { root, check } = fixture();
  try {
    const result = check(
      [
        '## Operator requests',
        '- "Successor tabs in herdr": t-abc1234',
        '- "Domain MCPs stay per project": memory:herdr-tabs',
        '* closed: rebase decision answered 2026-10-31',
        '',
        '## Grants',
        '- no pointer needed here',
        '',
      ].join('\n'),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /^PASS .*: 2 open operator request\(s\) recorded\n$/u,
    );
    for (const body of [
      '## Operator requests ##\n- closed: answered\n',
      '## Operator requests\r\n- "recorded": t-abc1234\r\n',
      '   ## Operator requests\n- none\n',
      '## Operator requests\n- "recorded" in memory:herdr-tabs.\n',
      '## Operator requests\n- "see this", then `memory:herdr-tabs` and t-abc1234\n',
      '## Operator requests\n- none\n',
    ]) {
      const result = check(body);
      assert.equal(result.status, 0, `${body}\n${result.stderr}`);
    }
    const bom = check('## Operator requests\n- none\n', [], '\uFEFF');
    assert.match(bom.stdout, /^PASS /u, bom.stderr);
    assert.equal(bom.status, 0, bom.stderr);
    const none = check('## Operator requests\n- none\n');
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /: 0 open operator request\(s\) recorded/u);
    const prelude = check(
      '## Operator requests\n- none\n',
      [],
      '# Handoff\n```inline` code\n',
    );
    assert.equal(prelude.status, 0, prelude.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('handoff check refuses requests without a durable record', () => {
  assert.ok(existsSync(script), 'handoff request check exists');
  const { root, check } = fixture();
  try {
    const cases: [string, RegExp][] = [
      ['## Grants\n- x\n', /no "## Operator requests" section/u],
      ['## Operator requests\n\n## Grants\n', /empty section; write "- none"/u],
      [
        '## Operator requests\n- open herdr tabs for successors\n',
        /:10: request has no task id, memory:<slug> or "closed: <reason>" prefix/u,
      ],
      [
        '## Operator requests\n- tabs t-0000000\n',
        /t-0000000 has no tasks\/t-0000000\.json/u,
      ],
      [
        '## Operator requests\n- tabs memory:missing\n',
        /memory:missing has no .*missing\.md/u,
      ],
      [
        '## Operator requests\n- none\n- t-abc1234\n',
        /"none" cannot sit beside other requests/u,
      ],
      ['## Operator requests\n- closed:\n', /request has no task id/u],
      [
        '```\n## Operator requests\n- none\n```\n',
        /no "## Operator requests" section/u,
      ],
      [
        '## Operator requests\n- none\n## Operator requests\n- unrecorded\n',
        /"none" cannot sit beside other requests/u,
      ],
      [
        '## Operator requests\n-\n- t-abc1234\n',
        /:10: request has no task id/u,
      ],
      [
        '## Operator requests\n- closed:resolved\n',
        /:10: request has no task id/u,
      ],
      [
        '## Operator requests\n- t-dir0000\n',
        /t-dir0000 has no tasks\/t-dir0000\.json/u,
      ],
      ['## Operator requests\n- memory:dir\n', /memory:dir has no /u],
      [
        '## Operator requests\nloose request\n',
        /:10: write each operator request as a top-level bullet/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n  ```\n- unrecorded request\n',
        /:11: indented lines are not allowed in the operator requests section/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n```inline` code\n- unrecorded request\n',
        /:11: fenced code is not allowed/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n```\n## Grants\n- loose\n```\n',
        /:11: fenced code is not allowed/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n  - unrecorded request\n',
        /:11: indented lines are not allowed/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n  1. unrecorded request\n',
        /:11: indented lines are not allowed/u,
      ],
      [
        '## Operator requests\n- unrecorded request\n\n t-abc1234\n',
        /:12: indented lines are not allowed/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n  ### Grants\n- unrecorded request\n',
        /:11: indented lines are not allowed/u,
      ],
      [
        '- a\n  ```\n## Operator requests\n- none\n',
        /:11: "operator requests" is ambiguous outside a "## Operator requests" heading/u,
      ],
      [
        'intro\r## Operator requests\r- unrecorded request\n## Operator requests\n- none\n',
        /:11: request has no task id/u,
      ],
      [
        'Operator requests\n---\n- unrecorded request\n\n## Operator requests\n- none\n',
        /:9: "operator requests" is ambiguous/u,
      ],
      [
        '> ## Operator requests\n> - unrecorded request\n## Operator requests\n- none\n',
        /:9: "operator requests" is ambiguous/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n##\n- unrecorded request\n',
        /:11: empty headings are not allowed/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n### Later\n- unrecorded request\n',
        /:11: subheadings are not allowed/u,
      ],
      [
        '  ```\n## Operator requests\n- unrecorded\n```\n## Operator requests\n- none\n',
        /:10: "operator requests" is ambiguous/u,
      ],
      [
        '## Operator requests\n- memory:a/../../etc/passwd\n',
        /memory:a\/\.\.\/\.\.\/etc\/passwd is not a memory file name/u,
      ],
      [
        '## Operator requests\r\n- unrecorded\r\n',
        /:10: request has no task id/u,
      ],
    ];
    for (const [body, expected] of cases) {
      const result = check(body);
      assert.equal(result.status, 1, body);
      assert.equal(result.stdout, '', body);
      assert.match(result.stderr, expected, body);
    }
    const usage = check('## Operator requests\n- none\n', ['--root']);
    assert.equal(usage.status, 64);
    assert.match(usage.stderr, /^Usage: /u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
