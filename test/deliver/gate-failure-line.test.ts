import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

type Module = { gateFailureLine: (output: unknown) => string };

async function load(): Promise<Module> {
  let module: Partial<Module> = {};
  try {
    module = (await import(
      '../../src/deliver/gate-failure.ts'
    )) as Partial<Module>;
  } catch (error) {
    assert.fail(`src/deliver/gate-failure.ts is unavailable: ${String(error)}`);
  }
  assert.equal(typeof module.gateFailureLine, 'function');
  return module as Module;
}

// Verbatim `gh api --paginate --slurp` capture of the krn/gate check runs on
// main 7b01635, the failure that named no stage (t-axrzg1n).
const readCapture = () =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('./fixtures/gate-no-stage.fixture', import.meta.url),
      ),
      'utf8',
    ),
  ) as { check_runs: { output: unknown }[] }[];

test('a captured no-stage failure names its primary cause and the stale library', async () => {
  const { gateFailureLine } = await load();
  const run = readCapture()[0]?.check_runs[0];
  assert.ok(run);
  assert.equal(
    gateFailureLine(run.output),
    "failed at stage unknown: hudson.AbortException: Error cloning remote repo 'origin'; the deployed Jenkins library predates stage summaries, repin library_sha",
  );
});

test('a staged summary yields its stage and cause', async () => {
  const { gateFailureLine } = await load();
  assert.equal(
    gateFailureLine({
      summary:
        'Attempt a1 failed at stage checkout: git fetch timed out; base=not-required; gate=false; cleanup=true; evidence=true',
      text: 'Attempt a1 failed at stage checkout: git fetch timed out\nPrimary: x',
    }),
    'failed at stage checkout: git fetch timed out',
  );
});

test('a run without summary or primary cause says so', async () => {
  const { gateFailureLine } = await load();
  for (const output of [null, undefined, {}, { summary: null, text: null }])
    assert.equal(
      gateFailureLine(output),
      'failed at stage unknown: the check run names no stage and no primary cause',
    );
});

test('the cause is one bounded printable line', async () => {
  const { gateFailureLine } = await load();
  const line = gateFailureLine({
    summary: 'Attempt a2 failed or is unverified',
    text: `Primary: \u001b[31mboom\u0007${'x'.repeat(500)}\nsecond line`,
  });
  const controls = [...line].filter((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 0x20 || (point >= 0x7f && point <= 0x9f);
  });
  assert.deepEqual(controls, []);
  assert.doesNotMatch(line, /second line/u);
  assert.match(line, /^failed at stage unknown: \[31mboom/u);
  assert.ok(line.length <= 400, String(line.length));
});

test('Unicode line and paragraph separators end the line and format characters are dropped', async () => {
  const { gateFailureLine } = await load();
  for (const separator of ['\u2028', '\u2029', '\r'])
    assert.equal(
      gateFailureLine({
        summary: `Attempt a3 failed at stage checkout: first${separator}second; base=x`,
      }),
      'failed at stage checkout: first',
    );
  assert.equal(
    gateFailureLine({
      summary: 'Attempt a4 failed or is unverified',
      text: 'Primary: a\u202eb\u2066c\u200bd\u0085e',
    }),
    'failed at stage unknown: abcde; the deployed Jenkins library predates stage summaries, repin library_sha',
  );
});
