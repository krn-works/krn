import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// Every CLI path that ships carries the guards `krn pr ship` carries (deploy refusal, claim
// release, base): a call that hand-builds its own runtime drops the ones it forgets.
test('every shipCommand caller outside src/ci/ship.ts passes cliShipRuntime', () => {
  const files = readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter(
      (f) =>
        f.endsWith('.ts') && join('src', f) !== join('src', 'ci', 'ship.ts'),
    )
    .map((f) => join('src', f));
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/shipCommand\(/gu)) {
      const call = text.slice(match.index, match.index + 300);
      if (!call.includes('cliShipRuntime')) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});
