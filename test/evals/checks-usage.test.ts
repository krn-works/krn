import test from 'node:test';
import { fixture, refusal } from './checks-fixture.ts';

test('eval check validates usage options before running', async () => {
  const f = await fixture();
  try {
    for (const extra of [
      ['--json'],
      ['--draft', '--draft'],
      ['--unknown'],
      ['--timeout', '0'],
      ['--timeout', 'NaN'],
      ['--timeout', '9007199254740992'],
      ['--timeout', '1', '--timeout', '2'],
      ['--slot', f.slot],
    ])
      refusal(f.run(extra), 64, /once|unknown|timeout|usage/u);
  } finally {
    await f.cleanup();
  }
});
