import test from 'node:test';
import { fixture, refusal } from './checks-fixture.ts';

test('eval check validates check selection and required options before running', async () => {
  const f = await fixture();
  try {
    for (const name of ['other', 'suite:-1', 'suite:01', 'suite:999']) {
      const args = f.args();
      args[args.indexOf('focused')] = name;
      refusal(f.invoke(args), 64, /check/u);
    }
    const unknown = f.args();
    unknown[unknown.indexOf('behavior')] = 'unknown';
    refusal(f.invoke(unknown), 65, /task/u);
    for (const option of ['--experiment', '--task', '--slot', '--check']) {
      const args = f.args();
      args.splice(args.indexOf(option), 2);
      refusal(f.invoke(args), 64, /usage/u);
    }
  } finally {
    await f.cleanup();
  }
});
