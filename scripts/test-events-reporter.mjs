import { closeSync, openSync, writeSync } from 'node:fs';

const eventFile = process.env.KRN_TEST_EVENT_FILE;
if (!eventFile) throw new Error('KRN_TEST_EVENT_FILE is required');
const descriptor = openSync(eventFile, 'a', 0o600);
const countFields = [
  'tests',
  'passed',
  'failed',
  'skipped',
  'todo',
  'cancelled',
];

function eventRecord(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string')
    return undefined;
  const data = event.data;
  if (!data || typeof data !== 'object') return { type: event.type, data: {} };
  const retained = {};
  for (const key of [
    'name',
    'nesting',
    'file',
    'entryFile',
    'skip',
    'todo',
    'testNumber',
    'success',
  ]) {
    if (Object.hasOwn(data, key)) retained[key] = data[key];
  }
  if (data.details && typeof data.details.type === 'string')
    retained.details = { type: data.details.type };
  if (data.counts && typeof data.counts === 'object') {
    retained.counts = {};
    for (const field of countFields) {
      if (Object.hasOwn(data.counts, field))
        retained.counts[field] = data.counts[field];
    }
  }
  return { type: event.type, data: retained };
}

export default async function* recordNativeEvents(source) {
  try {
    for await (const event of source) {
      const record = eventRecord(event);
      if (record) writeSync(descriptor, `${JSON.stringify(record)}\n`);
      yield '';
    }
  } finally {
    closeSync(descriptor);
  }
}
