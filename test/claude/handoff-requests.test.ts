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
  new URL('../../docs/program/repository-workflow.md', import.meta.url),
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
  const check = (
    body: string,
    extra: string[] = [],
    header = '# Handoff\n\n## Resume\n- Task: t-abc1234\n- SHAs: 5e1ce47\n- Verify: `npm run fast`\n- Roadmap: unchanged (fixture)\n## Priorities\n- t-zzzzzzz later\n',
  ) => {
    const handoff = join(root, 'handoff.md');
    writeFileSync(handoff, `${header}${body}`);
    return spawnSync(
      process.execPath,
      [script, handoff, '--root', root, ...extra],
      { encoding: 'utf8' },
    );
  };
  return { root, check };
}

test('the repository handoff rule runs the operator-request check on every handoff', () => {
  assert.ok(existsSync(script), 'handoff request check exists');
  const text = readFileSync(skill, 'utf8');
  assert.match(text, /node scripts\/claude\/handoff-requests\.ts /u);
});

test('the handoff layout is free: any prose passes while no open operator task is dropped', () => {
  const { root, check } = fixture();
  try {
    for (const body of [
      '',
      '## Operator requests\n- none\n',
      '- loose request\n  ```\n## Operator requests\n```\n',
      '## Operator requests\n## Operator requests\n- anything at all\n',
      '## Operator requests\r\n- t-abc1234\r\n',
    ]) {
      const result = check(body);
      assert.equal(result.status, 0, `${body}\n${result.stderr}`);
      assert.match(result.stdout, /^PASS .*: 0 open operator request\(s\)/u);
    }
    const bom = check(
      'free text\n',
      [],
      '\uFEFF## Resume\n- Task: t-abc1234\n- SHAs: 5e1ce47\n- Verify: `x`\n- Roadmap: unchanged (fixture)\n\n',
    );
    assert.equal(bom.status, 0, bom.stderr);
    const usage = check('x', ['--root']);
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
    const dropped = check('open t-op00001 only\n');
    assert.equal(dropped.status, 1, dropped.stderr);
    assert.match(
      dropped.stderr,
      /open operator request t-op00002 is not named in the handoff/u,
    );
    assert.doesNotMatch(
      dropped.stderr,
      /t-op00001 is missing|t-op00003|t-plain01/u,
    );
    const carried = check('open t-op00001, skills t-op00002\n');
    assert.equal(carried.status, 0, carried.stderr);
    assert.match(carried.stdout, /: 2 open operator request\(s\)/u);
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

test('handoff Roadmap line must name real task ids', () => {
  const { root, check } = fixture();
  try {
    const none = '## Operator requests\n- none\n';
    const header = (line: string) =>
      `# Handoff\n\n## Resume\n- Task: t-abc1234\n- SHAs: 5e1ce47\n- Verify: \`npm run fast\`\n- Roadmap: ${line}\n\n`;
    const missing = check(none, [], header('t-nofile0 reranked'));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /names t-nofile0, which has no task file/u);
    assert.equal(check(none, [], header('t-open000 reranked')).status, 0);
    // A closed task is still a named change: its row left the generated roadmap.
    assert.equal(check(none, [], header('t-abc1234 closed')).status, 0);
    assert.equal(check(none, [], header('t-open000 and t-nofile0')).status, 1);
    // The retired row ids no longer satisfy the field.
    assert.equal(check(none, [], header('R2 reranked')).status, 1);
    assert.equal(
      check(none, [], header('unchanged (no new evidence)')).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
