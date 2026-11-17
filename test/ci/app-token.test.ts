import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { mintToken, Unavailable } from '../../src/ci/app-token.ts';

const ITEM = 'KRN delivery GitHub App';
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const TOKEN = `ghs_${'a'.repeat(36)}`;

async function listen(
  t: { after(fn: () => void): void },
  handler: Parameters<typeof createServer>[1],
) {
  const server: Server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

// bw serve answers the item; GitHub drops the connection `drops` times (a
// network-level failure, no HTTP status), then answers `status`.
async function environment(
  t: { after(fn: () => void): void },
  drops: number,
  status: number,
) {
  const bw = await listen(t, (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        success: true,
        data: {
          data: [
            {
              name: ITEM,
              notes: pem,
              fields: [
                { name: 'app_id', value: '4242' },
                { name: 'installation_id', value: '77' },
              ],
            },
          ],
        },
      }),
    );
  });
  let calls = 0;
  const github = await listen(t, (req, res) => {
    calls += 1;
    if (calls <= drops) return void req.socket.destroy();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        status === 201
          ? { token: TOKEN, expires_at: '2099-01-01T00:00:00Z' }
          : { message: 'Bad credentials' },
      ),
    );
  });
  return {
    env: { KRN_BW_SERVE: bw, KRN_GITHUB_API: github } as NodeJS.ProcessEnv,
    calls: () => calls,
  };
}

test('a network-level failure twice, then 201, still returns the token', async (t) => {
  const fake = await environment(t, 2, 201);
  assert.equal(await mintToken(fake.env), TOKEN);
  assert.equal(fake.calls(), 3);
});

test('a 401 fails after one call without a retry', async (t) => {
  const fake = await environment(t, 0, 401);
  await assert.rejects(mintToken(fake.env), Unavailable);
  assert.equal(fake.calls(), 1);
});

test('a network failure that never clears gives up after three retries', async (t) => {
  const fake = await environment(t, 99, 201);
  await assert.rejects(mintToken(fake.env), Unavailable);
  assert.equal(fake.calls(), 4);
});

test('the bw serve unavailable error names the unit state from captured systemctl and journal output', async () => {
  const { describeBwServe } = await import('../../src/ci/bw-serve-state.ts');
  const capture = (name: string) =>
    readFileSync(
      new URL(`../fixtures/bw-serve/${name}`, import.meta.url),
      'utf8',
    );
  const message = describeBwServe((command) =>
    capture(
      command === 'systemctl'
        ? 'systemctl-show-failed.txt'
        : 'journal-failed.txt',
    ),
  );
  assert.match(message, /bw-serve\.service is failed/u);
  assert.match(message, /EADDRINUSE/u);
  assert.match(message, /bw-up is an operator command/u);
});
