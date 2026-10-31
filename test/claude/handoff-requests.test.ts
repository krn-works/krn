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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'handoff-requests-'));
  mkdirSync(join(root, 'tasks'));
  writeFileSync(join(root, 'tasks/t-abc1234.json'), '{}');
  mkdirSync(join(root, 'memory'));
  writeFileSync(join(root, 'memory/herdr-tabs.md'), 'fixture');
  const check = (body: string, extra: string[] = []) => {
    const handoff = join(root, 'handoff.md');
    writeFileSync(
      handoff,
      `# Handoff\n\n## Priorities\n- t-zzzzzzz later\n${body}`,
    );
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
        '- Successor tabs in herdr: t-abc1234',
        '- Domain MCPs stay per project,',
        '  recorded as memory:herdr-tabs',
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
      /^PASS .*: 3 open operator request\(s\) recorded\n$/u,
    );
    const none = check('## Operator requests\n- none\n');
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /: 0 open operator request\(s\) recorded/u);
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
        /:6: request has no task id, memory:<slug> or "closed:" prefix/u,
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
