import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reviewCommand } from '../../src/flow/cli.ts';
import { runReview } from '../../src/flow/index.ts';
import * as repository from '../../src/flow/repository.ts';
import { CodexHost } from '../../src/hosts/codex.ts';

const tier = await import('../../src/flow/tier.ts').catch(() => undefined);
const diffStat = (
  ...args: [string, string, string]
): { path: string; added: number | null; deleted: number | null }[] => {
  const read = (repository as Record<string, unknown>).diffStat;
  assert.equal(typeof read, 'function');
  return (
    read as (...values: [string, string, string]) => ReturnType<typeof diffStat>
  )(...args);
};
test('risk tiers follow trusted path and size rules', () => {
  assert.equal(typeof tier?.classifyRiskTier, 'function');
  assert.equal(typeof tier?.tierRoles, 'function');
  assert.ok(tier);
  const classify = tier.classifyRiskTier;
  const entry = (
    path: string,
    added: number | null = 1,
    deleted: number | null = 0,
  ) => ({ path, added, deleted });
  for (const path of [
    'docs/guide.txt',
    'test/a.ts',
    'tasks/a.json',
    'nested/readme.md',
  ])
    assert.equal(classify([entry(path, null, null)]).level, 'low', path);
  assert.equal(
    classify([entry('src/a.ts', 20), entry('src/b.ts', 20)]).level,
    'low',
  );
  for (const entries of [
    [entry('a.ts'), entry('b.ts'), entry('c.ts')],
    [entry('a.ts', 41)],
    [entry('a.ts', null, null)],
    [],
  ])
    assert.equal(classify(entries).level, 'medium');
  for (const path of [
    '.github/workflows/ci.yml',
    'docs/adr/x.md',
    'spec/worker-scope.json',
    'src/flow/index.ts',
    'scripts/install-tool.mjs',
    'package.json',
    'AGENTS.md',
    'docs/CLAUDE.md',
    '.claude/skills/krn-lead/SKILL.md',
    '.agents/skills/x/SKILL.md',
    'docs/program/lead-rules.md',
  ])
    assert.equal(classify([entry(path)]).level, 'high', path);
  for (const path of ['scripts/install/nested.ts', 'scripts/seal-tool/x.mjs'])
    assert.notEqual(classify([entry(path)]).level, 'high', path);
  assert.deepEqual(classify([]).reasons, ['empty diff']);
  assert.deepEqual(tier.tierRoles('low'), ['spec']);
  assert.deepEqual(tier.tierRoles('high'), [
    'standards',
    'spec',
    'adversarial',
  ]);
  const reason = classify([entry(`docs/adr/${'ą'.repeat(200)}.md`)]).reasons[0];
  assert.ok(reason);
  assert.ok(Buffer.byteLength(reason) <= 200);
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fakeCodex(directory: string): string {
  const executable = join(directory, 'fake-codex.mjs');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const text = JSON.stringify({ verdict: 'PASS', findings: [] });
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n');
`,
    { mode: 0o700 },
  );
  return executable;
}
test('docs-only review records a complete one-spec PASS panel', async () => {
  assert.equal(typeof tier?.classifyRiskTier, 'function');
  const parent = join(process.cwd(), '.krn', 'tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'review-tier-'));
  const originalStart = CodexHost.prototype.start;
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'KRN test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'README.md'), 'base\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture base');
    const base = git(root, 'rev-parse', 'HEAD');
    const path = 'guide\twith\nnewline.md';
    writeFileSync(join(root, path), 'guide\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture docs');
    const head = git(root, 'rev-parse', 'HEAD');
    assert.deepEqual(diffStat(root, base, head), [
      { path, added: 1, deleted: 0 },
    ]);
    const lens = join(root, 'lens.txt');
    writeFileSync(lens, 'Check acceptance.');
    const executable = fakeCodex(root);
    const roles: string[] = [];
    let response = '{"verdict":"PASS","findings":[]}';
    CodexHost.prototype.start = async (input) => {
      const role = /ROLE: (standards|spec|adversarial)/u.exec(
        input.prompt,
      )?.[1];
      assert.ok(role);
      roles.push(role);
      return {
        id: 'fake-spec',
        wait: async () => ({
          sessionId: 'fake-spec',
          reasonKind: 'agent_message',
          reasonSha256: 'a'.repeat(64),
          reasonLength: 32,
          claimsDone: true,
          finalMessage: response,
          exitCode: 0,
          signal: null,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          usageObservation: {
            turnsStarted: 1,
            turnsCompleted: 1,
            invalidFields: 0,
          },
        }),
      };
    };
    const record = await runReview({
      repo: root,
      base,
      head,
      lens,
      riskTier: true,
      codexExecutable: executable,
    });
    assert.deepEqual(roles, ['spec']);
    assert.deepEqual(
      record.judges.map(({ role }) => role),
      ['spec'],
    );
    assert.equal(record.panel?.partial, false);
    assert.equal(record.tier?.level, 'low');
    assert.equal(record.panelVerdict, 'PASS');
    const finding = {
      severity: 'BLOCKING',
      category: 'style',
      title: 'Style\ninjected',
      path: 'README.md',
      line: 1,
      defect: 'Formatting only',
      fix: 'Reformat',
    };
    response = JSON.stringify({ verdict: 'FAIL', findings: [finding] });
    writeFileSync(join(root, path), 'guide\nstyle\n');
    git(root, 'add', path);
    git(root, 'commit', '-qm', 'fixture style review');
    const styleHead = git(root, 'rev-parse', 'HEAD');
    const styled = await runReview({
      repo: root,
      base,
      head: styleHead,
      lens,
      riskTier: true,
      codexExecutable: executable,
    });
    assert.equal(styled.panelVerdict, 'PASS');
    assert.equal(
      styled.judges[0]?.state === 'complete' && styled.judges[0].droppedStyle,
      1,
    );
    assert.deepEqual(styled.consolidated, []);
    writeFileSync(join(root, path), 'guide\nstyle\nprepass\n');
    git(root, 'add', path);
    git(root, 'commit', '-qm', 'fixture style prepass');
    const styledPrepass = await runReview({
      repo: root,
      base,
      head: git(root, 'rev-parse', 'HEAD'),
      lens,
      riskTier: true,
      prepassChecklist: '- style: never blocks',
      codexExecutable: executable,
    });
    assert.equal(styledPrepass.panelVerdict, 'PASS');
    assert.deepEqual(
      styledPrepass.prepass?.state === 'complete' &&
        styledPrepass.prepass.findings,
      [],
    );
    mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(root, 'docs', 'adr', 'risk\ninjected.md'), 'Decision\n');
    git(root, 'add', 'docs');
    git(root, 'commit', '-qm', 'fixture high risk');
    const highHead = git(root, 'rev-parse', 'HEAD');
    response = JSON.stringify({
      verdict: 'FAIL',
      findings: [{ ...finding, category: 'correctness' }],
    });
    let output = '';
    const originalWrite = process.stdout.write;
    try {
      process.stdout.write = (chunk) => {
        output += String(chunk);
        return true;
      };
      assert.equal(
        await reviewCommand(
          [
            '--repo',
            root,
            '--base',
            base,
            '--head',
            highHead,
            '--lens',
            lens,
            '--risk-tier',
          ],
          { codexExecutable: executable },
        ),
        'FAIL',
      );
    } finally {
      process.stdout.write = originalWrite;
    }
    const lines = output.trim().split('\n');
    assert.equal(
      lines[0],
      'notice: high risk review tier: HIGH: docs/adr/risk',
    );
    assert.equal(lines[1], 'BLOCKING README.md:1 Style [votes 3]');
    assert.equal(lines.length, 3);
  } finally {
    CodexHost.prototype.start = originalStart;
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed numstat fails closed and binary counts remain null', () => {
  assert.ok(tier);
  const parent = join(process.cwd(), '.krn', 'tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'review-numstat-'));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${root}:${originalPath ?? ''}`;
    for (const output of [
      'malformed\0',
      '1\t0\tunterminated',
      '9007199254740992\t0\ttoo-big\0',
    ]) {
      writeFileSync(
        join(root, 'git'),
        `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\n`,
        { mode: 0o700 },
      );
      assert.deepEqual(tier.classifyRiskTier(diffStat(root, 'base', 'head')), {
        level: 'medium',
        reasons: ['unparsed diff'],
      });
    }
    writeFileSync(
      join(root, 'git'),
      '#!/usr/bin/env node\nprocess.stdout.write("-\\t-\\timage.png\\0");\n',
      { mode: 0o700 },
    );
    assert.deepEqual(diffStat(root, 'base', 'head'), [
      { path: 'image.png', added: null, deleted: null },
    ]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});
