import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { incidentRecords } from '../../src/brain/principle-check.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Records that still retell one incident. The list only shrinks: a rewritten record leaves it.
const ALLOWED = new Set(['r-stop-skip-needs-session-proof']);

const files = ['.agents/records.json', 'standards/records.json'];

test('every record text states a principle, so a hand edit cannot retell one incident', () => {
  const flagged = files.flatMap((file) =>
    incidentRecords(JSON.parse(readFileSync(join(root, file), 'utf8'))).map(
      (row) => ({ ...row, file }),
    ),
  );
  const unexpected = flagged.filter((row) => !ALLOWED.has(row.id));
  assert.deepEqual(
    unexpected,
    [],
    'state the principle and move the incident into provenance.evidence',
  );
  const stale = [...ALLOWED].filter(
    (id) => !flagged.some((row) => row.id === id),
  );
  assert.deepEqual(stale, [], 'remove the rewritten record from ALLOWED');
});
