import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Receiver captures are committed verbatim to a public repository, and their
// only sanctioned redaction is the host path (test/fixtures/README.md). The
// first Codex app-server recording (#393) carried the operator's credit
// balance, usage and installation id; a capture with account state fails here.
const root = fileURLToPath(new URL('../..', import.meta.url));
const accountKey =
  /"(?:accountId|balance|email|installationId|planType|usedPercent)"\s*:/u;

test('no committed receiver capture carries account state', () => {
  const fixtures = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'test'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter((path) => path.includes('/fixtures/'));
  assert.ok(fixtures.length > 0);
  assert.deepEqual(
    fixtures.flatMap((path) =>
      readFileSync(join(root, path), 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          accountKey.test(line) ? [`${path}:${index + 1}`] : [],
        ),
    ),
    [],
    'opt the notification out at the receiver or capture from an isolated home (test/fixtures/README.md)',
  );
});

test('the guard matches the account keys of a Codex rate-limit frame', () => {
  // account/rateLimits/updated as codex-cli 0.167.0 sends it, values zeroed.
  assert.match(
    '{"method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":0},"credits":{"balance":"0"},"planType":"x"}}}',
    accountKey,
  );
  assert.doesNotMatch(
    '{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{}}}',
    accountKey,
  );
});
