import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { reviewCommand } from '../../src/flow/cli.ts';
import {
  newReviewRecordSchema,
  panelRoles,
  reviewRecordSchema,
} from '../../src/flow/types.ts';
import { CodexHost, type CodexStartInput } from '../../src/hosts/codex.ts';

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('review records the exact checklist shown in prepass and prior verification', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'krn-review-checklist-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'value.txt'), 'base');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'value.txt'), 'prior');
  git(root, 'commit', '-qam', 'prior');
  const priorHead = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'value.txt'), 'head');
  git(root, 'commit', '-qam', 'head');
  let head = git(root, 'rev-parse', 'HEAD');
  const priorPath = join(root, 'prior.json');
  writeFileSync(
    priorPath,
    JSON.stringify({
      schemaVersion: 1,
      base,
      headSha: priorHead,
      createdAt: '2026-01-01T00:00:00.000Z',
      panelVerdict: 'FAIL',
      redFirst: [],
      judges: panelRoles.map((role) => ({
        state: 'complete',
        role,
        verdict: 'FAIL',
        sessionId: role,
        finalMessage: 'prior',
        findings: [
          {
            severity: 'BLOCKING',
            title: 'Empty input',
            path: 'value.txt',
            line: 1,
            defect: 'Input fails',
            fix: 'Handle input',
          },
        ],
      })),
    }),
  );
  const lens = join(root, 'lens.txt');
  const checklist = join(root, 'checklist.md');
  const bytes = Buffer.from('\uFEFF  - `symlink`: check paths\r\n\r\n  ');
  writeFileSync(lens, 'Check behavior');
  writeFileSync(checklist, bytes);
  const prompts: string[] = [];
  let prior = false;
  let blocking = false;
  t.mock.method(
    CodexHost.prototype,
    'start',
    async (input: CodexStartInput) => {
      prompts.push(input.prompt);
      const finalMessage = JSON.stringify({
        verdict: blocking ? 'FAIL' : 'PASS',
        findings: blocking
          ? [
              {
                severity: 'BLOCKING',
                title: 'Input fails',
                path: 'value.txt',
                line: 1,
                defect: 'Input fails',
                fix: 'Handle input',
              },
            ]
          : [],
        ...(prior
          ? {
              prior: panelRoles.map((_, index) => ({
                index,
                status: 'RESOLVED',
                evidence: 'Fixed input',
              })),
            }
          : {}),
      });
      return {
        id: 'mocked-transport',
        wait: async () => ({
          sessionId: 'mocked-transport',
          reasonKind: 'turn_complete',
          reasonSha256: 'e'.repeat(64),
          reasonLength: finalMessage.length,
          claimsDone: true,
          finalMessage,
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
    },
  );
  const args = ['--repo', root, '--base', base, '--head', head, '--lens', lens];
  for (const mode of ['prepass', 'prior', 'without', 'blocking'] as const) {
    if (mode !== 'prepass') {
      writeFileSync(join(root, 'value.txt'), mode);
      git(root, 'commit', '-qam', `head ${mode}`);
      head = git(root, 'rev-parse', 'HEAD');
      args[args.indexOf('--head') + 1] = head;
    }
    prior = mode === 'prior';
    blocking = mode === 'blocking';
    prompts.length = 0;
    const outcome = await reviewCommand([
      ...args,
      ...(mode === 'without' ? [] : ['--prepass', '--checklist', checklist]),
      ...(prior ? ['--prior-record', priorPath] : []),
    ]);
    assert.equal(outcome, blocking ? 'PREPASS_BLOCKING' : 'PASS');
    const record = JSON.parse(
      readFileSync(join(root, '.krn/runs/review', head, 'record.json'), 'utf8'),
    );
    if (mode === 'without') {
      assert.equal(Object.hasOwn(record, 'checklist'), false);
    } else {
      assert.deepEqual(record.checklist, {
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      const shown = prompts.filter((prompt) =>
        prompt.includes('DEFECT-CLASS CHECKLIST:'),
      );
      assert.equal(shown.length, prior ? 3 : 1);
      for (const prompt of shown)
        assert.ok(
          prompt.includes(
            `DEFECT-CLASS CHECKLIST:\n${bytes.toString('utf8')}\n\n`,
          ),
        );
    }
    for (const schema of [reviewRecordSchema, newReviewRecordSchema]) {
      assert.deepEqual(schema.parse(record), record);
      for (const digest of [
        'A'.repeat(64),
        'a'.repeat(63),
        '',
        'g'.repeat(64),
        123,
        null,
      ])
        assert.equal(
          schema.safeParse({ ...record, checklist: { sha256: digest } })
            .success,
          false,
        );
    }
  }
  const link = join(root, 'linked-checklist.md');
  symlinkSync(checklist, link);
  const before = prompts.length;
  await assert.rejects(
    reviewCommand([...args, '--prepass', '--checklist', link]),
    /regular file/u,
  );
  assert.equal(prompts.length, before);
});
