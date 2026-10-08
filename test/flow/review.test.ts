import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runReview } from '../../src/flow/index.ts';
import { parseJudgeResponse } from '../../src/flow/panel.ts';
import { appendOverride } from '../../src/flow/record.ts';
import { redFirst } from '../../src/flow/repository.ts';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'krn-review-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'KRN test');
  git(root, 'config', 'user.email', 'krn-test@example.invalid');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture base');
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fakeCodex(
  directory: string,
  response: string,
): { readonly executable: string; readonly argsFile: string } {
  const executable = join(directory, 'fake-codex.mjs');
  const argsFile = join(directory, 'codex-args.json');
  const encoded = JSON.stringify(response);
  writeFileSync(
    executable,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nlet prompt=''; for await (const chunk of process.stdin) prompt += chunk;\nwriteFileSync(process.env.KRN_REVIEW_ARGS, JSON.stringify(process.argv.slice(2)));\nconst text=${encoded};\nprocess.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\\n');\nprocess.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n');\n`,
  );
  chmodSync(executable, 0o700);
  process.env.KRN_REVIEW_ARGS = argsFile;
  return { executable, argsFile };
}

test('mechanical red-first distinguishes assertion failures from missing imports', () => {
  const { root, cleanup } = fixture();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    mkdirSync(join(root, 'test'));
    writeFileSync(
      join(root, 'test', 'assert.test.ts'),
      "import assert from 'node:assert/strict'; import { test } from 'node:test'; test('assertion', () => assert.equal(1, 2));\n",
    );
    writeFileSync(
      join(root, 'test', 'import.test.ts'),
      "import '../src/missing-module.ts';\n",
    );
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'add failing tests');
    const head = git(root, 'rev-parse', 'HEAD');
    const report = redFirst(root, base, head);
    assert.deepEqual(
      report.results.map(({ classification }) => classification),
      ['assertion', 'procedural'],
      JSON.stringify(report.results),
    );
  } finally {
    cleanup();
  }
});

test('a judge response without a verdict cannot be parsed into a review record', () => {
  assert.throws(() => parseJudgeResponse('{"findings":[]}'));
});

test('panel launcher forces read-only and a lead override is appended after FAIL', async () => {
  const { root, cleanup } = fixture();
  const priorArgs = process.env.KRN_REVIEW_ARGS;
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src.ts'), 'export const answer = 42;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'review target');
    const head = git(root, 'rev-parse', 'HEAD');
    const lens = join(root, 'lens.txt');
    writeFileSync(lens, 'Check acceptance and operational behaviour.\n');
    const response = JSON.stringify({
      verdict: 'FAIL',
      findings: [
        {
          severity: 'BLOCKING',
          title: 'Defect',
          path: 'src.ts',
          line: 1,
          defect: 'Acceptance is broken.',
          fix: 'Correct the condition.',
        },
      ],
    });
    const fake = fakeCodex(root, response);
    assert.throws(() =>
      appendOverride(root, head, {
        reason: 'before verdict',
        evidence: 'missing record',
      }),
    );
    const record = await runReview({
      repo: root,
      base,
      head,
      lens,
      panel: ['standards'],
      codexExecutable: fake.executable,
      timeoutMs: 30000,
    });
    assert.equal(record.judges[0]?.verdict, 'FAIL');
    const args = JSON.parse(readFileSync(fake.argsFile, 'utf8')) as string[];
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    const updated = appendOverride(root, head, {
      reason: 'accepted residual risk',
      evidence: 'verified in the follow-up probe',
    });
    assert.equal(updated.override?.reason, 'accepted residual risk');
    assert.equal(updated.headSha, head);
  } finally {
    if (priorArgs === undefined) delete process.env.KRN_REVIEW_ARGS;
    else process.env.KRN_REVIEW_ARGS = priorArgs;
    cleanup();
  }
});

test('an invalid judge verdict leaves no review record', async () => {
  const { root, cleanup } = fixture();
  const priorArgs = process.env.KRN_REVIEW_ARGS;
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src.ts'), 'export const answer = 42;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'review target');
    const head = git(root, 'rev-parse', 'HEAD');
    const lens = join(root, 'lens.txt');
    writeFileSync(lens, 'Check acceptance.\n');
    const fake = fakeCodex(root, '{"findings":[]}');
    await assert.rejects(
      runReview({
        repo: root,
        base,
        head,
        lens,
        panel: ['spec'],
        codexExecutable: fake.executable,
      }),
    );
    assert.throws(() =>
      readFileSync(join(root, '.krn', 'runs', 'review', head, 'record.json')),
    );
  } finally {
    if (priorArgs === undefined) delete process.env.KRN_REVIEW_ARGS;
    else process.env.KRN_REVIEW_ARGS = priorArgs;
    cleanup();
  }
});
