import test from 'node:test';
import { fixture, refusal } from './checks-fixture.ts';

test('eval check validates strict manifest node and portable working directories', async () => {
  const f = await fixture();
  try {
    const original = JSON.stringify(f.task);
    const cases: Record<string, unknown>[] = [
      { node: 'v24.22.1' },
      { node: '24' },
      { workingDirectory: '' },
      { workingDirectory: '../package' },
      { workingDirectory: '/package' },
      { workingDirectory: './package' },
      { workingDirectory: 'package/' },
      { workingDirectory: 'a//b' },
      { workingDirectory: 'a\\b' },
      { workingDirectory: 'a\0b' },
    ];
    for (const change of cases) {
      Object.assign(f.task, JSON.parse(original), change);
      await f.save();
      refusal(f.run(), 65, /manifest/u);
    }
    Object.assign(f.task, JSON.parse(original), {
      workingDirectory: '.',
      node: '0.0.0',
    });
    await f.save();
    refusal(f.run(), 65, /[Nn]ode.*0\.0\.0/u);
  } finally {
    await f.cleanup();
  }
});
