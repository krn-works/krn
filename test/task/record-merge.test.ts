import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';
import { mergeTaskRecords } from '../../src/task/record-merge.ts';

const base: TaskRecord = {
  id: 't-abc1234',
  status: 'open',
  resolution: null,
  created: '2026-11-13',
  priority: 2,
  title: 'Lane run task',
  after: [],
  body: ['Outcome: o'],
} as TaskRecord;
const text = (change: Partial<TaskRecord>) =>
  serializeTask({ ...base, ...change } as TaskRecord);
const closed = {
  status: 'closed',
  resolution: { kind: 'done', ref: null, note: 'lane delivered' },
} as unknown as Partial<TaskRecord>;

test('a lane close and a lead body note merge into one record', () => {
  const result = mergeTaskRecords({
    base: text({}),
    lane: text(closed),
    main: text({ body: ['Outcome: o', 'Lead note: rework'] }),
  });
  assert.deepEqual(result, {
    merged: text({ ...closed, body: ['Outcome: o', 'Lead note: rework'] }),
  });
});

test('body items appended on both sides keep the lane items first and drop duplicates', () => {
  const result = mergeTaskRecords({
    base: text({}),
    lane: text({ body: ['Outcome: o', 'lane', 'shared'] }),
    main: text({ body: ['Outcome: o', 'shared', 'lead'] }),
  });
  assert.deepEqual(result, {
    merged: text({ body: ['Outcome: o', 'lane', 'shared', 'lead'] }),
  });
});

test('two different edits of one field are a conflict naming the field', () => {
  assert.deepEqual(
    mergeTaskRecords({
      base: text({}),
      lane: text({ title: 'Lane title' }),
      main: text({ title: 'Lead title' }),
    }),
    { conflict: 'title' },
  );
  assert.deepEqual(
    mergeTaskRecords({
      base: text({}),
      lane: text(closed),
      main: text({
        status: 'closed',
        resolution: { kind: 'done', ref: null, note: 'lead closed it' },
      } as unknown as Partial<TaskRecord>),
    }),
    { conflict: 'resolution' },
  );
  // A rewritten body item is not an append, so the body conflicts.
  assert.deepEqual(
    mergeTaskRecords({
      base: text({}),
      lane: text({ body: ['Outcome: changed'] }),
      main: text({ body: ['Outcome: o', 'lead'] }),
    }),
    { conflict: 'body' },
  );
});

test('an unreadable copy is reported, never merged', () => {
  const result = mergeTaskRecords({
    base: text({}),
    lane: '{',
    main: text({}),
  });
  assert.ok('invalid' in result && result.invalid.startsWith('lane: '));
});
