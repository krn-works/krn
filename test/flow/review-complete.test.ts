import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../../src/cli/main.ts';
import { reviewCommand } from '../../src/flow/cli.ts';
import { CodexHost, type CodexStartInput } from '../../src/hosts/codex.ts';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(): {
  readonly root: string;
  readonly base: string;
  readonly head: string;
  readonly lens: string;
  readonly checklist: string;
  readonly cleanup: () => void;
} {
  const parent = join(process.cwd(), '.krn', 'tmp', 'review-complete');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'KRN test');
  git(root, 'config', 'user.email', 'krn-test@example.invalid');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture base');
  const base = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'src.ts'), 'export const answer = 42;\n');
  git(root, 'add', 'src.ts');
  git(root, 'commit', '-qm', 'review target');
  const head = git(root, 'rev-parse', 'HEAD');
  const lens = join(root, 'lens.txt');
  const checklist = join(root, 'checklist.txt');
  writeFileSync(
    lens,
    'The stated contract must hold for every accepted input.\n',
  );
  writeFileSync(checklist, 'Boundary inputs\nError paths\n');
  return {
    root,
    base,
    head,
    lens,
    checklist,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function captureStdout<T>(run: () => Promise<T>): Promise<{
  readonly output: string;
  readonly value: T;
}> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === 'string' && chunk.startsWith('{')) {
      output += chunk;
      return true;
    }
    return originalWrite(chunk);
  }) as typeof process.stdout.write;
  return run()
    .then((value) => ({ output, value }))
    .finally(() => {
      process.stdout.write = originalWrite;
    });
}

test('review requests complete-pass findings and keeps prepass outside verdicts', async () => {
  const originalStart = CodexHost.prototype.start;
  const starts: CodexStartInput[] = [];
  let responses: string[] = [];
  CodexHost.prototype.start = async (input) => {
    starts.push(input);
    const finalMessage =
      responses.shift() ?? '{"verdict":"PASS","findings":[]}';
    return {
      id: `fake-review-session-${starts.length}`,
      wait: async () => ({
        sessionId: `fake-review-session-${starts.length}`,
        reasonKind: 'turn_complete',
        reasonSha256: 'a'.repeat(64),
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
  };

  try {
    const standard = fixture();
    try {
      responses = Array.from(
        { length: 3 },
        () => '{"verdict":"PASS","findings":[]}',
      );
      const before = starts.length;
      const { output, value } = await captureStdout(() =>
        reviewCommand([
          '--repo',
          standard.root,
          '--base',
          standard.base,
          '--head',
          standard.head,
          '--lens',
          standard.lens,
        ]),
      );
      assert.equal(value, 'PASS');
      assert.equal(starts.length - before, 3);
      const prompt = starts[before]?.prompt ?? '';
      assert.match(
        prompt,
        /enumerate ALL defects that would make the stated contract false/iu,
      );
      assert.match(prompt, /one pass/u);
      assert.match(prompt, /Do not stop at the first defect/u);
      assert.match(prompt, /order findings by severity/iu);
      assert.match(prompt, /concrete failing input or scenario/u);
      assert.ok(output.startsWith('{'), JSON.stringify(output.slice(0, 120)));
      const outputRecord = JSON.parse(output) as { readonly record: string };
      const persisted = JSON.parse(
        readFileSync(outputRecord.record, 'utf8'),
      ) as Record<string, unknown>;
      assert.deepEqual(Object.keys(persisted), [
        'schemaVersion',
        'headSha',
        'base',
        'createdAt',
        'panelVerdict',
        'redFirst',
        'contracts',
        'redFirstCauses',
        'judges',
        'lensSha256',
        'panel',
        'toolSha',
      ]);
    } finally {
      standard.cleanup();
    }

    const adversarial = fixture();
    try {
      const blocking = JSON.stringify({
        verdict: 'FAIL',
        findings: [
          {
            severity: 'BLOCKING',
            title: 'Boundary input breaks contract',
            path: 'src.ts',
            line: 1,
            defect: 'The empty input returns an invalid result.',
            fix: 'Handle the empty input explicitly.',
          },
        ],
      });
      responses = [blocking];
      const before = starts.length;
      const originalExitCode = process.exitCode;
      process.exitCode = 0;
      let output: string;
      let exitCode: string | number | undefined;
      try {
        const captured = await captureStdout(async () => {
          main([
            'review',
            '--repo',
            adversarial.root,
            '--base',
            adversarial.base,
            '--head',
            adversarial.head,
            '--lens',
            adversarial.lens,
            '--prepass',
            '--checklist',
            adversarial.checklist,
          ]);
          for (
            let attempt = 0;
            attempt < 100 && process.exitCode === 0;
            attempt++
          )
            await new Promise<void>((resolveTick) => setImmediate(resolveTick));
          return process.exitCode;
        });
        output = captured.output;
        exitCode = captured.value;
      } finally {
        process.exitCode = originalExitCode ?? 0;
      }
      assert.equal(exitCode, 3);
      assert.equal(
        starts.length - before,
        1,
        'blocking prepass must stop before the panel',
      );
      const prompt = starts[before]?.prompt ?? '';
      assert.match(prompt, /Boundary inputs/u);
      assert.match(prompt, /Error paths/u);
      const response = JSON.parse(output) as {
        readonly prepass: {
          readonly findings: readonly { readonly severity: string }[];
        };
        readonly record: string;
      };
      assert.equal(response.prepass.findings[0]?.severity, 'BLOCKING');
      const persisted = JSON.parse(
        readFileSync(response.record, 'utf8'),
      ) as Record<string, unknown>;
      assert.ok('prepass' in persisted);
      assert.equal('panelVerdict' in persisted, false);
      assert.deepEqual(persisted.judges, []);
    } finally {
      adversarial.cleanup();
    }
  } finally {
    CodexHost.prototype.start = originalStart;
  }
});
