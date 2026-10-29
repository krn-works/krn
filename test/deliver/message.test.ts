import assert from 'node:assert/strict';
import test from 'node:test';

const api = await import('../../src/deliver/message.ts').catch(() => undefined);
const trailers =
  'Ticket: t-pst5y0h\nChange-contract: test/deliver/message.test.ts:red->green\nCo-Authored-By: Contributor <contributor@example.com>\n';

test('merge message preserves one final trailer paragraph from the head', () => {
  assert.equal(typeof api?.mergeMessage, 'function');
  assert.ok(api);
  const message = api.mergeMessage(
    'feat(deliver): deliver reviewed PR (t-pst5y0h)',
    trailers,
    't-pst5y0h',
  );
  assert.equal(message.split('\n\n').at(-1), trailers);
  assert.ok(
    message.startsWith('feat(deliver): deliver reviewed PR (t-pst5y0h)\n\n'),
  );
  assert.throws(
    () => api.mergeMessage('feat: x', trailers, 't-other'),
    /Ticket/u,
  );
  assert.throws(
    () =>
      api.mergeMessage(
        'feat: x',
        trailers.replace('red->green', 'green->green'),
      ),
    /red->green/u,
  );
  assert.throws(
    () => api.mergeMessage('feat: x', `${trailers}Ticket: t-other\n`),
    /Ticket/u,
  );
});
