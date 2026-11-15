import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countStopRefusals,
  precedentModules,
  proofLine,
  proofOf,
} from '../../src/brain/proof-line.ts';

const hook = 'exec krn hook stop';
const refusal = (text: string) =>
  JSON.stringify({
    type: 'system',
    subtype: 'stop_hook_summary',
    hookErrors: [`[${hook}]: ${text}\n`],
  });
const allowed = JSON.stringify({
  type: 'system',
  subtype: 'stop_hook_summary',
  hookErrors: [],
});

const brief = `Precedent (commits reachable from HEAD touching the named modules, with the test changes they made; match these messages):
### \`src/a.ts\`
- 1234abcde fix a
### \`src/b.ts\`
- 2345bcdef fix b

Acceptance clauses (cover every one):
1. First clause stated by the brief.
2. Second clause stated by the brief.
3. Third clause stated by the brief.
- For each clause N, commit a test whose name contains "clause N".`;

test('clause 6: the proof line prints the four counts in the stated shape', () => {
  const line = proofLine(
    proofOf({
      brief,
      tests: new Map([
        [
          'test/a.test.ts',
          "test('clause 1: a', () => {}); test('clause 3: c', () => {});",
        ],
      ]),
      messages: 'Clause 2: not reproducible: process step',
      firstCommitFiles: ['test/a.test.ts'],
      stopRefusals: 2,
    }),
  );
  assert.equal(
    line,
    'proof: clauses 3/3, red-first 1, precedent 2 modules, stop refusals 2',
  );
});

test('clause 7: counts come from the lane records, not estimates', () => {
  const none = proofOf({
    brief,
    tests: new Map(),
    messages: '',
    firstCommitFiles: ['src/a.ts'],
    stopRefusals: 0,
  });
  assert.deepEqual(none, {
    clauses: 0,
    clausesTotal: 3,
    redFirst: 0,
    precedent: 2,
    stopRefusals: 0,
  });
  // Clause 1 must not be matched by clause 12 or by a marker for clause 10.
  const partial = proofOf({
    brief,
    tests: new Map([['test/a.test.ts', "test('clause 12 only', () => {})"]]),
    messages: '',
    firstCommitFiles: [],
    stopRefusals: 0,
  });
  assert.equal(partial.clauses, 0);
  assert.equal(
    countStopRefusals(
      [refusal('Stop refused: a'), allowed, refusal('Stop refused: b')].join(
        '\n',
      ),
    ),
    2,
  );
  assert.equal(
    precedentModules(
      'Precedent (no Scope: line; siblings):\nSibling tests:\n- `test/x.test.ts`\nSibling helpers:\n- `src/x.ts`',
    ),
    2,
  );
  assert.equal(precedentModules('no section'), 0);
});

test('clause 8: a brief with under two clauses counts the clauses the worker wrote', () => {
  const written = proofOf({
    brief: 'Acceptance clauses (write them first):\nThe task states under 2.',
    tests: new Map([
      ['test/a.test.ts', "test('clause 1: x'); test('clause 2: y');"],
    ]),
    messages: '',
    firstCommitFiles: [],
    stopRefusals: 0,
  });
  assert.equal(written.clauses, 2);
  assert.equal(written.clausesTotal, 2);
});
