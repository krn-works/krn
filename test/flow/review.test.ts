import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { reviewCommand } from '../../src/flow/cli.ts';
import { parseVerdict } from '../../src/flow/panel.ts';
import { CodexHost, type CodexStartInput } from '../../src/hosts/codex.ts';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const blocking = {
  severity: 'BLOCKING',
  title: 't',
  path: 'src.ts',
  line: 1,
  defect: 'd',
  fix: 'f',
};

test('parseVerdict enforces the PASS/FAIL and BLOCKING invariant', () => {
  assert.equal(
    parseVerdict('{"verdict":"PASS","findings":[]}').verdict,
    'PASS',
  );
  assert.throws(() =>
    parseVerdict(JSON.stringify({ verdict: 'PASS', findings: [blocking] })),
  );
  assert.throws(() => parseVerdict('{"verdict":"FAIL","findings":[]}'));
  assert.throws(() => parseVerdict('not json'));
});

test('review runs the panel in parallel and maps verdicts to outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-review-'));
  const original = CodexHost.prototype.start;
  const starts: CodexStartInput[] = [];
  let responses: string[] = [];
  CodexHost.prototype.start = async (input) => {
    starts.push(input);
    const finalMessage = responses.shift() ?? '';
    return {
      id: `fake-${starts.length}`,
      wait: async () => ({
        sessionId: `fake-${starts.length}`,
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
  const write = process.stdout.write.bind(process.stdout);
  let printed = '';
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'KRN test');
    git(root, 'config', 'user.email', 'krn-test@example.invalid');
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src.ts'), 'export const a = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'head');
    const lens = join(root, 'lens.txt');
    writeFileSync(lens, 'contract holds\n');
    const args = [
      '--repo',
      root,
      '--base',
      base,
      '--head',
      'HEAD',
      '--lens',
      lens,
    ];
    process.stdout.write = ((chunk: string) => {
      printed += chunk;
      return true;
    }) as typeof process.stdout.write;
    const pass = '{"verdict":"PASS","findings":[]}';
    responses = [pass, pass, pass];
    assert.equal(await reviewCommand(args), 'PASS');
    responses = [
      pass,
      JSON.stringify({ verdict: 'FAIL', findings: [blocking] }),
      pass,
    ];
    assert.equal(await reviewCommand(args), 'FAIL');
    responses = [pass, 'garbage', pass];
    assert.equal(await reviewCommand(args), 'INCOMPLETE');
    assert.equal(starts.length, 9);
    assert.ok(starts.every((s) => s.prompt.includes('contract holds')));
    assert.match(printed, /"outcome": "INCOMPLETE"/u);
  } finally {
    process.stdout.write = write;
    CodexHost.prototype.start = original;
    rmSync(root, { recursive: true, force: true });
  }
});
