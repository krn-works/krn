import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeTestEvents } from '../../scripts/test-summary-policy.mjs';

const reporter = fileURLToPath(
  new URL('../../scripts/test-events-reporter.mjs', import.meta.url),
);

// Real events from the Node test runner through the suite's own reporter.
function recordRealEvents() {
  const directory = mkdtempSync(join(tmpdir(), 'krn-summary-policy-'));
  try {
    const file = join(directory, 'two.test.mjs');
    writeFileSync(
      file,
      "import test from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n",
    );
    const eventFile = join(directory, 'events.jsonl');
    writeFileSync(eventFile, '');
    const run = spawnSync(
      process.execPath,
      [
        '--test',
        `--test-reporter=${reporter}`,
        '--test-reporter-destination=stdout',
        file,
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, KRN_TEST_EVENT_FILE: eventFile },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const events = readFileSync(eventFile, 'utf8')
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line));
    return { file, events };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const isFileSummary = (event) =>
  event.type === 'test:summary' && Object.hasOwn(event.data, 'entryFile');

test('a file whose tests all passed is accepted when its own summary is lost', () => {
  const { file, events } = recordRealEvents();
  assert.equal(events.filter(isFileSummary).length, 1);
  const lost = events.filter((event) => !isFileSummary(event));

  const result = summarizeTestEvents(lost, [file], 0);

  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.success, true);
  assert.equal(result.summary.files.length, 1);
  assert.equal(result.summary.files[0].file, file);
  assert.equal(result.summary.files[0].tests, 2);
  assert.equal(result.summary.files[0].passed, 2);
});

test('a file that stopped before every enqueued test settled still fails without its summary', () => {
  const { file, events } = recordRealEvents();
  const lastPass = events.findLastIndex(
    (event) => event.type === 'test:pass' && event.data.entryFile === file,
  );
  const stopped = events.filter(
    (event, index) => !isFileSummary(event) && index !== lastPass,
  );

  const result = summarizeTestEvents(stopped, [file], 0);

  assert.equal(result.summary.success, false);
  assert.ok(result.errors.includes(`missing per-file summary: ${file}`));
});
