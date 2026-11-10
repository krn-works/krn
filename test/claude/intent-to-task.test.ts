import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classify,
  type Input,
  median,
  summary,
} from '../../scripts/claude/intent-to-task.ts';

const entry = (hash: string, time: string, text: string) => ({
  hash,
  session: 'a',
  time,
  text,
});
const base: Input = {
  entries: [
    entry('h1', '2026-11-08T10:00:00Z', 'dodaj to'),
    entry('h2', '2026-11-08T11:00:00Z', 'a to co?'),
    entry(
      'h3',
      '2026-11-08T12:00:00Z',
      'First run `node scripts/claude/successor-launch.ts --retire` from',
    ),
    entry('h4', '2026-11-08T13:00:00Z', 'nigdzie zapisane'),
    entry('h5', '2026-11-08T14:00:00Z', 'drugie zadanie'),
    entry('h6', '2026-11-01T10:00:00Z', 'poza oknem'),
  ],
  dispositions: [
    { hash: 'h1', kind: 'task', ref: 't-aaaaaaa', time: 'x' },
    { hash: 'h2', kind: 'answered', ref: 'explained in chat', time: 'x' },
    { hash: 'h3', kind: 'task', ref: 't-aaaaaaa', time: 'x' },
    { hash: 'h5', kind: 'task', ref: 't-bbbbbbb', time: 'x' },
  ],
  tasks: new Map([
    ['t-aaaaaaa', { open: false, done: true }],
    ['t-bbbbbbb', { open: true, done: false }],
  ]),
  merges: new Map([
    [
      't-aaaaaaa',
      [Date.parse('2026-11-08T09:00:00Z'), Date.parse('2026-11-08T12:00:00Z')],
    ],
  ]),
  from: '2026-11-03',
  to: '2026-11-10',
  now: Date.parse('2026-11-10T00:00:00Z'),
};

test('rows outside the window are dropped and a launcher template is automation, not an operator row', () => {
  const rows = classify(base);
  assert.deepEqual(
    rows.map((row) => [row.hash, row.group]),
    [
      ['h1', 'task'],
      ['h2', 'chat'],
      ['h3', 'automation'],
      ['h4', 'undisposed'],
      ['h5', 'task'],
    ],
  );
});

test('the merge time is the first closing merge at or after the prompt', () => {
  const [first] = classify(base);
  assert.equal(first?.mergeHours, 2);
  assert.equal(first?.allDone, true);
});

test('an open task more than a day old is counted as still open', () => {
  const rows = classify(base);
  assert.equal(rows.find((row) => row.hash === 'h5')?.openAfterDay, true);
  assert.equal(rows.find((row) => row.hash === 'h1')?.openAfterDay, false);
});

test('the summary reports shares over operator rows only', () => {
  const text = summary(classify(base));
  assert.match(text, /operator 4\b/u);
  assert.match(text, /share with a task: 50% \(2\/4\)/u);
  assert.match(
    text,
    /share closed done \(of rows with a task\): 50% \(1\/2\)/u,
  );
  assert.match(text, /median 2\.0 h over 1 rows/u);
});

test('the median of an even count is the mean of the middle two', () => {
  assert.equal(median([3, 1, 2, 4]), 2.5);
  assert.equal(median([]), undefined);
});
