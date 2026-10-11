import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const title = 'docs(program): reset review system (LON-225)';
const commitMessage =
  'docs(program): reset review system\n\nTicket: LON-225\nR1-task: none\n';
const scriptUrl = new URL('../scripts/pr-preflight.mjs', import.meta.url).href;

function evaluateMetadata(input: {
  title: string;
  commitMessage: string;
  paperclipDescription: string;
}) {
  const code = `const { evaluateMetadata } = await import(${JSON.stringify(scriptUrl)}); process.stdout.write(JSON.stringify(evaluateMetadata(JSON.parse(process.argv[1]))));`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code, JSON.stringify(input)],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as {
    ticket: string | null;
    task: string | null;
    reasons: string[];
  };
}

test('preflight accepts matching conventional title, trailers, and live mapping', () => {
  assert.deepEqual(
    evaluateMetadata({
      title,
      commitMessage,
      paperclipDescription: 'Decision record\nR1-task: none\n',
    }),
    { ticket: 'LON-225', task: 'none', reasons: [] },
  );
});

test('preflight rejects a live Paperclip task mapping mismatch', () => {
  const result = evaluateMetadata({
    title,
    commitMessage,
    paperclipDescription: 'R1-task: R1-17\n',
  });
  assert.ok(
    result.reasons.includes(
      'live Paperclip R1-task line does not match the head commit trailer',
    ),
  );
});

test('preflight rejects duplicate or mismatched commit trailers', () => {
  const result = evaluateMetadata({
    title,
    commitMessage: `${commitMessage}Ticket: LON-224\n`,
    paperclipDescription: 'R1-task: none\n',
  });
  assert.ok(
    result.reasons.includes(
      'head commit must contain exactly one matching Ticket trailer',
    ),
  );
});
