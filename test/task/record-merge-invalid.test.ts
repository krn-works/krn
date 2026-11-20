import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseTaskDocument,
  serializeTask,
  type TaskRecord,
} from '../../src/task/record.ts';
import { mergeTaskRecords } from '../../src/task/record-merge.ts';

test('mergeTaskRecords refuses to emit an invalid closed-done record with unpassed acceptance', () => {
  const base: TaskRecord = {
    id: 't-mrg0001',
    status: 'open',
    resolution: null,
    created: '2026-11-20',
    priority: 2,
    title: 'Mergeable task',
    after: [],
    body: ['Outcome: exit 0'],
  };
  const lane: TaskRecord = {
    ...base,
    status: 'closed',
    resolution: { kind: 'done', ref: null, note: 'proved on lane' },
  };
  const main: TaskRecord = {
    ...base,
    acceptance: [{ verify: 'npm test', passes: false, exit: null }],
  };

  const merged = mergeTaskRecords({
    base: serializeTask(base),
    lane: serializeTask(lane),
    main: serializeTask(main),
  });
  if ('merged' in merged) {
    const parsed = parseTaskDocument(merged.merged);
    assert.deepEqual(
      parsed.findings,
      [],
      `mergeTaskRecords emitted an invalid task record: ${parsed.findings.join('; ')}`,
    );
  }
});
