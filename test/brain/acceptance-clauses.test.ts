import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BOUNDARY_WORDS,
  characterizingTests,
  clauseMarker,
  clauseProof,
  clauseSection,
  declaresCharacterizes,
  declaresNotAffected,
  declaresNotReproducible,
  isBugBody,
  isTestFile,
  markedTests,
  missingBoundary,
  namesBoundary,
  splitClauses,
} from '../../src/brain/acceptance-clauses.ts';
import {
  briefClauses,
  proofLine,
  proofOf,
} from '../../src/brain/proof-line.ts';

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
  assert.match(
    clauseSection('Fix the parser crash on empty input'),
    /write them first[\s\S]*at least 3 numbered clauses/u,
  );
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

// Verbatim from the outside py-bug row: the lane's commit message and the clause markers of its test file.
const pyMessage = `fix(unzip_http): reject members resolving outside target (t-0x3pmx6)

Clause 1, 2 and 4 are covered by tests in tests/test_import.py.
Clause 3: not reproducible: members inside the target already extract correctly at base; the test guards that behavior.

Ticket: t-0x3pmx6
`;
const pyTest = `@pytest.mark.parametrize('case', ['clause 1'], ids=['clause 1'])
def test_clause_1_extract_rejects_escaping_member_names(case, tmp_path):
@pytest.mark.parametrize('case', ['clause 2'], ids=['clause 2'])
def test_clause_2_unsafe_member_writes_nothing(case, tmp_path):
@pytest.mark.parametrize('case', ['clause 3'], ids=['clause 3'])
def test_clause_3_members_inside_target_extract(case, tmp_path):
@pytest.mark.parametrize('case', ['clause 4'], ids=['clause 4'])
def test_clause_4_fix_in_unzip_http_module(case, tmp_path):
`;
const pyClauses = [
  "Bug (Zip Slip): member names come from the archive, so '../x', '/tmp/x' or 'sub/../../x' escape the target path.",
  "Outcome: a member whose resolved path is outside the target directory raises an Exception whose message contains 'unsafe path' and writes nothing.",
  'Members inside the target extract as before.',
  'Fix unzip_http.py and add a test.',
];

test('clause 2: a clause whose test already passes at the base is proven by head alone', () => {
  const { clauses } = clauseProof({
    stated: pyClauses,
    tests: new Map([['tests/test_import.py', pyTest]]),
    messages: pyMessage,
  });
  assert.deepEqual(
    clauses.map((c) => c.proven),
    [true, true, true, true],
  );
  assert.equal(clauses[2]?.declared, true);
});

test('clause 2: a marked test that fails on head proves nothing, a declared line still does', () => {
  const { clauses } = clauseProof({
    stated: pyClauses,
    tests: new Map([['tests/test_import.py', pyTest]]),
    messages: pyMessage,
    headFailing: new Set(['tests/test_import.py']),
  });
  assert.deepEqual(
    clauses.map((c) => c.proven),
    [false, false, true, false],
  );
});

test('clause 1: a brief of five clauses with no marked test proves none, as the proof line prints', () => {
  const stated = ['a', 'b', 'c', 'd', 'e'].map(
    (x) => `Clause text ${x} stated by the brief`,
  );
  const { clauses } = clauseProof({
    stated,
    tests: new Map([
      ['test/a.test.js', "test('parses a link header', () => {})"],
    ]),
    messages: 'Make standard s-readme-test-command pass',
  });
  assert.equal(clauses.filter((c) => c.proven).length, 0);
  const brief = `Acceptance clauses (cover every one):\n${stated.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n- For each clause N`;
  assert.equal(
    proofLine(
      proofOf({
        brief,
        tests: new Map(),
        messages: '',
        firstCommitFiles: [],
        redAtBase: [],
        stopRefusals: 1,
      }),
    ),
    'proof: clauses 0/5, red-first 0, precedent 0 modules, stop refusals 1, diff-coverage n/a',
  );
});

test('clause 2: a worker-written list counts the numbers it marked, and markedTests names those files', () => {
  const tests = new Map([
    ['test/a.test.ts', '// clause 1\n// clause 3\n'],
    ['test/b.test.ts', 'nothing'],
  ]);
  const { own, clauses } = clauseProof({ stated: [], tests, messages: '' });
  assert.equal(own, true);
  assert.deepEqual(
    clauses.map((c) => c.n),
    [1, 3],
  );
  assert.deepEqual(markedTests([], tests), ['test/a.test.ts']);
});

test('clause 9: a characterizes line needs a reason and names the marked test files', () => {
  assert.equal(
    declaresCharacterizes('Clause 2: characterizes: already works', 2),
    true,
  );
  assert.equal(declaresCharacterizes('Clause 2: characterizes', 2), false);
  assert.equal(
    declaresCharacterizes('Clause 2: characterizes: already works', 3),
    false,
  );
  const tests = new Map([
    ['test/a.test.ts', "test('clause 2: x', () => {})"],
    ['test/b.test.ts', "test('clause 3: y', () => {})"],
  ]);
  assert.deepEqual(
    characterizingTests('Clause 2: characterizes: already works', tests),
    ['test/a.test.ts'],
  );
  assert.match(
    clauseSection('1. Parse the header line\n2. Reject an empty header'),
    /characterizes/u,
  );
});

test('clause 7: sweep call sites join the stated clauses, are read back from the brief, and a not-affected line proves one', () => {
  const sweep = [
    'Sibling call site src/a.py:3: roundTotal(x)',
    'Sibling call site src/b.py:9: roundTotal(y)',
  ];
  const text = clauseSection(
    'Bug: roundTotal truncates the total value.',
    sweep,
  );
  const brief = text;
  const stated = briefClauses(brief);
  assert.equal(stated.length, 2);
  const { clauses } = clauseProof({
    stated,
    tests: new Map([['tests/test_a.py', '# clause 1']]),
    messages: 'Clause 2: not affected: src/b.py already rounds up',
  });
  assert.deepEqual(
    clauses.map((c) => c.proven),
    [true, true],
  );
  assert.equal(declaresNotAffected('Clause 2: not affected', 2), false);
  assert.equal(
    proofOf({
      brief,
      tests: new Map(),
      messages: '',
      firstCommitFiles: [],
      redAtBase: [],
      stopRefusals: 0,
    }).clausesTotal,
    2,
  );
});

test('clause 6: a bug body is told apart from a feature body', () => {
  assert.equal(isBugBody('Bug: the total is wrong when empty'), true);
  assert.equal(isBugBody('Add a --json flag to the list command'), false);
});

// Outside php row 1115k: the lane changed tests/run.php and Stop answered
// "no test file changed on this branch".
test('a runner script directly under tests/ is a test file in php, python and js', () => {
  for (const path of [
    'tests/run.php',
    'test/run.py',
    'tests/run.js',
    'pkg/tests/run.php',
    // Outside rust row 1115k3: a Rust integration test.
    'tests/test_downcast.rs',
  ])
    assert.equal(isTestFile(path), true, path);
  for (const path of [
    'src/run.php',
    'tests/fixtures/data.php',
    'run.py',
    'src/lib.rs',
  ])
    assert.equal(isTestFile(path), false, path);
});

// Outside php row 1115k: "PHP method names can't contain a space", so the
// lane could not mark a test `clause 1` (php.log BLOCKER of t-04ewf93).
test('a clause marker reads identifier forms where a name cannot hold a space', () => {
  for (const name of [
    'public function testClause1(): void',
    'def test_clause_1():',
    'func TestClause1Parses(t *testing.T)',
    "test('Clause 1: parses')",
  ])
    assert.ok(clauseMarker(1).test(name), name);
  for (const name of ['testClause12', 'subclause 1', 'testclause1x'])
    assert.ok(!clauseMarker(1).test(name), name);
});

test('clause 1: a boundary class is named by a clause text or a marked test line, and its absence is reported', () => {
  const happy = clauseProof({
    stated: ['Parse the header line', 'Print the parsed header'],
    tests: new Map([['test/a.test.ts', '// clause 1 clause 2']]),
    messages: '',
  }).clauses;
  assert.match(
    missingBoundary(
      happy,
      new Map([['test/a.test.ts', '// clause 1 clause 2']]),
    ) ?? '',
    /empty input/u,
  );
  const named = clauseProof({
    stated: ['Parse the header line', 'Reject an empty header'],
    tests: new Map(),
    messages: '',
  }).clauses;
  assert.equal(missingBoundary(named, new Map()), undefined);
  assert.equal(namesBoundary('handles non-ASCII names'), true);
});

test('clause 2: a pytest file whose clause tests name empty input and non-ASCII text covers the boundary, and the refusal lists the accepted words', () => {
  // verbatim capture of the tests a lane committed in an outside Python run
  const pytest = readFileSync(
    new URL('./fixtures/pytest-clause-tests.txt', import.meta.url),
    'utf8',
  );
  const proof = clauseProof({
    stated: [],
    tests: new Map([['tests/test_import.py', pytest]]),
    messages: 'Clause 3: boundary cases covered.\n',
  }).clauses;
  assert.ok(proof.length >= 3);
  assert.equal(
    missingBoundary(proof, new Map([['tests/test_import.py', pytest]])),
    undefined,
  );
  for (const name of [
    'def test_clause_3_empty_input():',
    'def test_clause_3_non_ascii_names():',
    'testClause3EmptyInput',
    'it("clause 3 rejects \'\'")',
  ])
    assert.equal(namesBoundary(name), true, name);
  assert.equal(namesBoundary('def test_clause_3_parses():'), false);
  assert.match(BOUNDARY_WORDS, /empty.*non-ASCII.*unicode/u);
});
