import test from 'node:test';
import { fixture, refusal } from './checks-fixture.ts';

test('eval check validates strict manifest scripts and suite checks', async () => {
  const f = await fixture();
  try {
    const original = JSON.stringify(f.task);
    const cases: Record<string, unknown>[] = [
      { scripts: JSON.parse('{"__proto__":"true"}') },
      { scripts: { constructor: 'true' } },
      { scripts: { '': 'true' } },
      { scripts: { 'a=b': 'true' } },
      { scripts: { 'a/b': 'true' } },
      { scripts: { 'a\0b': 'true' } },
      { scripts: { test: '\0' } },
      { scripts: { test: '' } },
      { scripts: { test: '   ' } },
      { suiteChecks: [] },
      { suiteChecks: [{ argv: ['true'], tests: false, unknown: true }] },
      { suiteChecks: [{ argv: [], tests: true }] },
      { suiteChecks: [{ argv: ['true'] }] },
    ];
    for (const change of cases) {
      Object.assign(f.task, JSON.parse(original), change);
      await f.save();
      refusal(f.run(), 65, /manifest/u);
    }
  } finally {
    await f.cleanup();
  }
});
