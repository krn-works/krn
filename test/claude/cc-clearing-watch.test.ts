import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  countTranscriptHits,
  run,
  scanFile,
} from '../../src/context/cc-clearing-watch.ts';

const fx = (name: string) =>
  join(import.meta.dirname, 'fixtures', 'cc-watch', name);
const tmp = () => mkdtempSync(join(tmpdir(), 'ccw-'));

test('stubbed overrides, idle constant and markers are read from the 2.1.319 snippets', async () => {
  const dir = tmp();
  const bin = join(dir, 'bin');
  writeFileSync(
    bin,
    ['overrides-null.txt', 'idle-planner.txt', 'markers.txt']
      .map((n) => readFileSync(fx(n), 'utf8'))
      .join('\n'),
  );
  assert.deepEqual(await scanFile(bin), {
    overrides: 'null',
    clearType: true,
    flag: true,
    idleSeconds: 3900,
  });
});

test('an implemented getEnvironmentOverrides is reported live', async () => {
  assert.equal((await scanFile(fx('overrides-live.txt'))).overrides, 'live');
});

test('a match straddling a chunk boundary is still found', async () => {
  const dir = tmp();
  const bin = join(dir, 'bin');
  const pad = 'x'.repeat(8 * 2 ** 20 - 20);
  writeFileSync(bin, pad + readFileSync(fx('overrides-null.txt'), 'utf8'));
  assert.equal((await scanFile(bin)).overrides, 'null');
});

test('transcripts count only recent files with a clear edit', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'a.jsonl'), readFileSync(fx('transcript-hit.jsonl')));
  writeFileSync(
    join(dir, 'b.jsonl'),
    readFileSync(fx('transcript-miss.jsonl')),
  );
  writeFileSync(
    join(dir, 'old.jsonl'),
    readFileSync(fx('transcript-hit.jsonl')),
  );
  const old = new Date(Date.now() - 30 * 86_400_000);
  utimesSync(join(dir, 'old.jsonl'), old, old);
  assert.equal(await countTranscriptHits(dir), 1);
});

test('the timer run prints one verdict line, exits 0 while unreachable and 1 once changed', async () => {
  const dir = tmp();
  const base = { cacheDir: join(dir, 'cache'), transcripts: join(dir, 'none') };
  const bin = join(dir, '2.9.9', 'claude');
  mkdirSync(join(dir, '2.9.9'));
  writeFileSync(bin, readFileSync(fx('overrides-null.txt')));
  const quiet = await run({ ...base, binary: bin });
  assert.equal(quiet.code, 0);
  assert.match(quiet.output, /^claude 2\.9\.9 .* unchanged$/u);
  const other = join(dir, '2.9.10');
  mkdirSync(other);
  writeFileSync(join(other, 'claude'), readFileSync(fx('overrides-live.txt')));
  const live = await run({ ...base, binary: join(other, 'claude') });
  assert.equal(live.code, 1);
  assert.match(live.output, /CHANGED/u);
  assert.equal((await run({ ...base, binary: null })).code, 1);
});
