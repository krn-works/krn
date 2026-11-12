import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRequirementsPrompt,
  cleanRequirements,
  leakedLines,
  requirementsProblem,
} from '../../evals/d23/requirements.ts';

const source = [
  "test('prints the line', async () => {",
  "  assert.equal(out, 'merge: not observed within 30s');",
  '  assert.equal(code, 78);',
  '});',
].join('\n');

test('the requirements prompt carries task, interface, module and test text and forbids quoting tests', () => {
  const prompt = buildRequirementsPrompt({
    task: 'Task t-aaaaaaa: greet politely',
    iface: '- `src/greet.ts` exports `greet`',
    tests: [{ path: 'test/greet.test.ts', source }],
    modules: [{ path: 'src/greet.ts', source: 'export const old = 1;' }],
  });
  for (const part of [
    'greet politely',
    '`src/greet.ts` exports `greet`',
    'export const old = 1;',
    'merge: not observed within 30s',
    'Never quote or paraphrase test code',
    'Write in English',
  ])
    assert.ok(prompt.includes(part), part);
});

test('the leak guard rejects text that copies a test-body line and accepts a stated literal', () => {
  const tests = [{ source }];
  assert.deepEqual(
    leakedLines(
      "- assert.equal(out, 'merge: not observed within 30s');",
      tests,
    ),
    ["assert.equal(out, 'merge: not observed within 30s');"],
  );
  assert.deepEqual(
    leakedLines(
      '- when the merge is not seen the command prints `merge: not observed within 30s` and exits `78`',
      tests,
    ),
    [],
  );
});

test('the leak guard ignores whitespace differences', () => {
  assert.equal(
    leakedLines("assert.equal(out,   'merge: not observed within 30s');", [
      { source },
    ]).length,
    1,
  );
});

test('a fenced model answer is unwrapped', () => {
  assert.equal(cleanRequirements('```text\n- a\n- b\n```\n'), '- a\n- b');
});

test('a reply with a preamble or in another language is not usable requirements', () => {
  assert.equal(requirementsProblem('- prints `ok` and exits 0'), undefined);
  assert.match(
    requirementsProblem('Here are the requirements:\n- a') ?? '',
    /bullet/,
  );
  assert.match(requirementsProblem('- zwraca wartość') ?? '', /English/);
});
