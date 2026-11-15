import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clauseMarker,
  clauseSection,
  declaresNotReproducible,
  splitClauses,
} from '../../src/brain/acceptance-clauses.ts';

test('numbered clauses in parentheses, with a bracket or with a dot split in order', () => {
  const expected = ['Parse the header line', 'Reject an empty header'];
  assert.deepEqual(
    splitClauses('(1) Parse the header line (2) Reject an empty header'),
    expected,
  );
  assert.deepEqual(
    splitClauses('1) Parse the header line\n2) Reject an empty header'),
    expected,
  );
  assert.deepEqual(
    splitClauses('1. Parse the header line\n2. Reject an empty header'),
    expected,
  );
});

test('bullets, then sentences, split a plain body', () => {
  assert.deepEqual(
    splitClauses(
      'Intro line:\n- Parse the header line\n- Reject an empty header',
    ),
    ['Parse the header line', 'Reject an empty header'],
  );
  assert.deepEqual(
    splitClauses('Parse the header line. Reject an empty header.'),
    ['Parse the header line.', 'Reject an empty header.'],
  );
});

test('a body with fewer than two clauses has none', () => {
  assert.deepEqual(splitClauses('Fix the parser crash on empty input'), []);
  assert.deepEqual(splitClauses(''), []);
  assert.equal(clauseSection('Fix the parser crash on empty input'), '');
});

test('clause markers do not confuse clause 1 with clause 12', () => {
  assert.ok(clauseMarker(1).test("test('clause 1: parses')"));
  assert.ok(!clauseMarker(1).test("test('clause 12: parses')"));
  assert.ok(clauseMarker(2).test('// Clause_2'));
});

test('not-reproducible needs a reason', () => {
  assert.ok(
    declaresNotReproducible(
      'x\n\nClause 2: not reproducible: already fixed',
      2,
    ),
  );
  assert.ok(!declaresNotReproducible('Clause 2: not reproducible', 2));
  assert.ok(!declaresNotReproducible('Clause 2: not reproducible: why', 1));
});

test('the section numbers every clause and states the red-green rule', () => {
  const text = clauseSection(
    '1. Parse the header line\n2. Reject an empty header',
  );
  assert.match(text, /^1\. Parse the header line$/mu);
  assert.match(text, /^2\. Reject an empty header$/mu);
  assert.match(text, /"clause N"/u);
});
