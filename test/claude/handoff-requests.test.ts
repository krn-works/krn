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
  writeFileSync(join(root, 'tasks/t-open000.json'), '{"status":"open"}');
  mkdirSync(join(root, 'docs/program'), { recursive: true });
  writeFileSync(
    join(root, 'docs/program/roadmap.md'),
    '| Id | Opportunity | Task |\n|---|---|---|\n| R1 | open work | t-open000 |\n',
  );
  mkdirSync(join(root, 'memory'));
  writeFileSync(join(root, 'memory/herdr-tabs.md'), 'fixture');
  mkdirSync(join(root, 'tasks/t-dir0000.json'));
  mkdirSync(join(root, 'memory/dir.md'));
  const check = (
    body: string,
    extra: string[] = [],
    header = '# Handoff\n\n## Resume\n- Task: t-abc1234\n- SHAs: 5e1ce47\n- Verify: `npm run fast`\n- Roadmap: unchanged (fixture)\n## Priorities\n- t-zzzzzzz later\n',
  ) => {
    const handoff = join(root, 'handoff.md');
    writeFileSync(handoff, `${header}${body}`);
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
        '- Domain MCPs stay per project, recorded as memory:herdr-tabs',
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
      '## Operator requests\r\n- t-abc1234\r\n',
      '   ## Operator requests\n- none\n',
      '## Operator requests\n- recorded in memory:herdr-tabs.\n',
      '## Operator requests\n- see `memory:herdr-tabs`, then t-abc1234\n',
      '```inline` code\n## Operator requests\n- none\n',
    ]) {
      const result = check(body);
      assert.equal(result.status, 0, `${body}\n${result.stderr}`);
    }
    const bom = check(
      '## Operator requests\n- none\n',
      [],
      '\uFEFF## Resume\n- Task: t-abc1234\n- SHAs: 5e1ce47\n- Verify: `x`\n- Roadmap: unchanged (fixture)\n\n',
    );
    assert.match(bom.stdout, /^PASS /u, bom.stderr);
    assert.equal(bom.status, 0, bom.stderr);
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
        /:11: request has no task id, memory:<slug> or "closed: <reason>" prefix/u,
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
        /:11: request has no task id/u,
      ],
      [
        '## Operator requests\n- closed:resolved\n',
        /:11: request has no task id/u,
      ],
      [
        '## Operator requests\n- t-dir0000\n',
        /t-dir0000 has no tasks\/t-dir0000\.json/u,
      ],
      ['## Operator requests\n- memory:dir\n', /memory:dir has no /u],
      [
        '## Operator requests\nloose request\n',
        /:11: write each operator request as a top-level bullet/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n  ```\n- unrecorded request\n',
        /:12: indented lines are not allowed in the operator requests section/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n```inline` code\n- unrecorded request\n',
        /:12: fenced code is not allowed/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n```\n## Grants\n- loose\n```\n',
        /:12: fenced code is not allowed/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n  - unrecorded request\n',
        /:12: indented lines are not allowed/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n  1. unrecorded request\n',
        /:12: indented lines are not allowed/u,
      ],
      [
        '## Operator requests\n- unrecorded request\n\n t-abc1234\n',
        /:13: indented lines are not allowed/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n  ### Grants\n- unrecorded request\n',
        /:12: indented lines are not allowed/u,
      ],
      [
        '- a\n  ```\n## Operator requests\n- none\n',
        /:12: "operator requests" is ambiguous outside a "## Operator requests" heading/u,
      ],
      [
        'intro\r## Operator requests\r- unrecorded request\n## Operator requests\n- none\n',
        /:12: request has no task id/u,
      ],
      [
        'Operator requests\n---\n- unrecorded request\n\n## Operator requests\n- none\n',
        /:10: "operator requests" is ambiguous/u,
      ],
      [
        '> ## Operator requests\n> - unrecorded request\n## Operator requests\n- none\n',
        /:10: "operator requests" is ambiguous/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n##\n- unrecorded request\n',
        /:12: empty headings are not allowed/u,
      ],
      [
        '## Operator requests\n- t-abc1234\n### Later\n- unrecorded request\n',
        /:12: subheadings are not allowed/u,
      ],
      [
        '  ```\n## Operator requests\n- unrecorded\n```\n## Operator requests\n- none\n',
        /:11: "operator requests" is ambiguous/u,
      ],
      [
        '## Operator requests\n- memory:a/../../etc/passwd\n',
        /memory:a\/\.\.\/\.\.\/etc\/passwd is not a memory file name/u,
      ],
      [
        '## Operator requests\r\n- unrecorded\r\n',
        /:11: request has no task id/u,
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

test('an open task that records an operator request must be carried', () => {
  const { root, check } = fixture();
  try {
    const task = (id: string, status: string, body: string) =>
      writeFileSync(
        join(root, `tasks/${id}.json`),
        JSON.stringify({ id, status, body: [body] }),
      );
    task('t-op00001', 'open', 'Operator 2026-11-05 (verbatim): "dawaj"');
    task('t-op00002', 'open', 'Operator asked for skills.');
    task('t-op00003', 'closed', 'Operator asked earlier.');
    task('t-plain01', 'open', 'Refactor the parser.');
    const dropped = check('## Operator requests\n- open t-op00001\n');
    assert.equal(dropped.status, 1, dropped.stderr);
    assert.match(dropped.stderr, /open operator request t-op00002 is missing/u);
    assert.doesNotMatch(
      dropped.stderr,
      /t-op00001 is missing|t-op00003|t-plain01/u,
    );
    const carried = check(
      '## Operator requests\n- open t-op00001\n- skills t-op00002\n',
    );
    assert.equal(carried.status, 0, carried.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('handoff check refuses a handoff missing the resume fields', () => {
  const { root, check } = fixture();
  try {
    const none = '## Operator requests\n- none\n';
    const lacking = (header: string) => check(none, [], header);
    const bare = lacking('# Handoff\n\n');
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /no "## Resume" section/u);
    for (const [field, resume] of [
      [
        'Task',
        '- SHAs: 5e1ce47\n- Verify: `npm run fast`\n- Roadmap: unchanged (fixture)\n',
      ],
      [
        'SHAs',
        '- Task: t-abc1234\n- Verify: `npm run fast`\n- Roadmap: unchanged (fixture)\n',
      ],
      [
        'Verify',
        '- Task: t-abc1234\n- SHAs: 5e1ce47\n- Verify: npm run fast\n- Roadmap: unchanged (fixture)\n',
      ],
      [
        'Roadmap',
        '- Task: t-abc1234\n- SHAs: 5e1ce47\n- Verify: `npm run fast`\n- Roadmap: unchanged\n',
      ],
    ] as const) {
      const result = lacking(`# Handoff\n\n## Resume\n${resume}\n`);
      assert.equal(result.status, 1, field);
      assert.match(result.stderr, new RegExp(`lacks "- ${field}:"`, 'u'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('handoff Roadmap line must name real roadmap rows', () => {
  const { root, check } = fixture();
  try {
    const none = '## Operator requests\n- none\n';
    const header = (line: string) =>
      `# Handoff\n\n## Resume\n- Task: t-abc1234\n- SHAs: 5e1ce47\n- Verify: \`npm run fast\`\n- Roadmap: ${line}\n\n`;
    const missing = check(none, [], header('R2 reranked after the slice'));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /names R2, which has no row/u);
    mkdirSync(join(root, 'docs/program'), { recursive: true });
    writeFileSync(
      join(root, 'docs/program/roadmap.md'),
      '| Id | Opportunity | Task |\n|---|---|---|\n| R2 | faster CI | t-open000 |\n| R3 | less spend |\n',
    );
    assert.equal(check(none, [], header('R2 reranked')).status, 0);
    assert.equal(check(none, [], header('R2 and R9')).status, 1);
    // Stable ids: a row pruned in a recent commit is still a named change.
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: root,
      });
    git('init', '-q');
    git('add', 'docs');
    git('commit', '-qm', 'base');
    writeFileSync(
      join(root, 'docs/program/roadmap.md'),
      '| Id | Opportunity | Task |\n|---|---|---|\n| R2 | faster CI | t-open000 |\n',
    );
    git('commit', '-qam', 'prune R3');
    assert.equal(check(none, [], header('R3 pruned')).status, 0);
    assert.equal(check(none, [], header('R9 pruned')).status, 1);
    assert.equal(
      check(none, [], header('unchanged (no new evidence)')).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('handoff cannot carry Roadmap unchanged over a roadmap without an open task', () => {
  const { root, check } = fixture();
  try {
    const none = '## Operator requests\n- none\n';
    const unchanged =
      '# Handoff\n\n## Resume\n- Task: t-abc1234\n- SHAs: 5e1ce47\n- Verify: `npm run fast`\n- Roadmap: unchanged (no new evidence)\n\n';
    const roadmap = join(root, 'docs/program/roadmap.md');
    assert.equal(check(none, [], unchanged).status, 0);
    writeFileSync(roadmap, '| Id | Opportunity | Task |\n|---|---|---|\n');
    const empty = check(none, [], unchanged);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /refill the roadmap/u);
    writeFileSync(
      roadmap,
      '| Id | Opportunity | Task |\n|---|---|---|\n| R1 | done work | t-abc1234 |\n',
    );
    assert.equal(check(none, [], unchanged).status, 1);
    rmSync(roadmap);
    assert.equal(check(none, [], unchanged).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
