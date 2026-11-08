import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import {
  play,
  problems,
  scenarios,
} from '../../scripts/codex/worker-scenarios.ts';
import { stubSystemd } from './session-fixture.ts';

// KRN-12 receiver proof without a paid live run: the real CLI, driver and
// CodexAppServer talk to transcripts recorded from codex app-server by
// `KRN_LIVE=1 node scripts/live-worker.mjs --record`.
const fixtures = resolve('test/fixtures/codex-app-server');
const provenance = z
  .object({
    receiver: z.string(),
    captures: z.array(
      z.object({ name: z.string(), file: z.string(), sha256: z.string() }),
    ),
  })
  .parse(JSON.parse(readFileSync(join(fixtures, 'provenance.json'), 'utf8')));

function firstDifference(actual: string, expected: string) {
  const got = actual.split('\n');
  const want = expected.split('\n');
  for (let line = 0; line < Math.max(got.length, want.length); line++)
    if (got[line] !== want[line])
      return { line: line + 1, expected: want[line], actual: got[line] };
  return undefined;
}

test('every scenario has one recorded transcript, listed with its sha256', () => {
  assert.deepEqual(
    provenance.captures.map((capture) => capture.name),
    scenarios.map((scenario) => scenario.name),
  );
  assert.deepEqual(
    provenance.captures.map((capture) => capture.file).sort(),
    readdirSync(fixtures)
      .filter((file) => file !== 'provenance.json')
      .sort(),
  );
  for (const capture of provenance.captures)
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(fixtures, capture.file)))
        .digest('hex'),
      capture.sha256,
      `${capture.file} changed; re-record it`,
    );
});

for (const scenario of scenarios)
  test(`the worker replays the recorded ${scenario.name} session`, {
    timeout: 60000,
  }, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'krn-replay-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    stubSystemd(bin);
    const transcript = join(fixtures, `${scenario.name}.rpc`);
    const played = await play(scenario, root, {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CODEX_KRN_REPLAY: transcript,
    });
    // The first frame KRN wrote differently names the regression.
    assert.deepEqual(
      {
        difference: firstDifference(
          readFileSync(played.log, 'utf8'),
          readFileSync(transcript, 'utf8'),
        ),
        problems: problems(scenario, played),
      },
      { difference: undefined, problems: [] },
    );
  });
