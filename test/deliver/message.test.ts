import assert from 'node:assert/strict';
import test from 'node:test';

const api = await import('../../src/deliver/message.ts').catch(() => undefined);
const trailers =
  'Ticket: t-pst5y0h\nChange-contract: test/deliver/message.test.ts:red->green\nCo-Authored-By: Contributor <contributor@example.com>\n';

test('merge message preserves one final trailer paragraph from the head', () => {
  assert.equal(typeof api?.mergeMessage, 'function');
  assert.ok(api);
  let message = '';
  // The PR number is a required input; a failure to accept it is the defect.
  assert.doesNotThrow(() => {
    message = api.mergeMessage(
      'feat(deliver): deliver reviewed PR (t-pst5y0h)',
      trailers,
      7,
      't-pst5y0h',
    );
  });
  assert.equal(
    message.split('\n')[0],
    'feat(deliver): deliver reviewed PR (#7)',
  );
  // Receiver source: scripts/lib/ship/ship.mjs, regex ^[a-z][a-z0-9-]*(?:\([^)]+\))?!?: .+ \(#([1-9]\d*)\)$
  const receiverSubject =
    /^[a-z][a-z0-9-]*(?:\([^)]+\))?!?: .+ \(#([1-9]\d*)\)$/;
  const subject = message.split('\n')[0];
  assert.ok(subject);
  assert.equal(receiverSubject.exec(subject)?.[1], '7');
  assert.equal(message.split('\n\n').at(-1), trailers);
  assert.equal(
    api.mergeMessage('feat(x): y', trailers, 7).split('\n')[0],
    'feat(x): y (#7)',
  );
  assert.equal(
    api.mergeMessage('feat(x): y (#7)', trailers, 7).split('\n')[0],
    'feat(x): y (#7)',
  );
  assert.equal(
    api
      .mergeMessage('feat(x): y (t-abc1234) extra', trailers, 7)
      .split('\n')[0],
    'feat(x): y (t-abc1234) extra (#7)',
  );
  assert.equal(
    api.mergeMessage('feat: foo(#7)', trailers, 7).split('\n')[0],
    'feat: foo(#7) (#7)',
  );
  assert.throws(
    () => api.mergeMessage('feat: x', trailers, 7, 't-other'),
    /Ticket/u,
  );
  assert.throws(
    () =>
      api.mergeMessage(
        'feat: x',
        trailers.replace('red->green', 'green->green'),
        7,
      ),
    /red->green/u,
  );
  assert.throws(
    () => api.mergeMessage('feat: x', `${trailers}Ticket: t-other\n`, 7),
    /Ticket/u,
  );
});
