import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import {
  codexErrorRetryable,
  codexTurnFailure,
  limitClass,
  resetAt,
  rpcErrorCode,
} from '../../src/worker/failure.ts';

const fixtures = resolve('test/fixtures/codex-app-server-schema');
const read = (file: string) =>
  JSON.parse(readFileSync(join(fixtures, file), 'utf8'));
// A synthetic account/rateLimits/read result (codex app-server 0.167.0
// GetAccountRateLimitsResponse shape). It lives here, not under fixtures:
// committed receiver captures carry no account state.
const rateLimitsRead = () => ({
  rateLimits: {
    limitId: 'codex',
    primary: {
      usedPercent: 100,
      windowDurationMins: 300,
      resetsAt: 1794150000,
    },
    secondary: {
      usedPercent: 40,
      windowDurationMins: 10080,
      resetsAt: 1794600000,
    },
    individualLimit: null as null | Record<string, unknown>,
  },
  rateLimitsByLimitId: null,
});

test('schema fixtures are pinned by sha256 and labelled verbatim or synthetic', () => {
  const provenance = z
    .object({
      receiver: z.string(),
      files: z.array(
        z.object({
          file: z.string(),
          origin: z.string().regex(/^(?:verbatim|synthetic): /),
          sha256: z.string(),
        }),
      ),
    })
    .parse(read('provenance.json'));
  assert.deepEqual(
    provenance.files.map((entry) => entry.file).sort(),
    readdirSync(fixtures)
      .filter((file) => file !== 'provenance.json')
      .sort(),
  );
  for (const entry of provenance.files)
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(fixtures, entry.file)))
        .digest('hex'),
      entry.sha256,
      `${entry.file} changed; regenerate it`,
    );
});

test('every CodexErrorInfo variant of the schema is classified, and nothing else', () => {
  const variants = z
    .object({
      definitions: z.object({
        CodexErrorInfo: z.object({
          anyOf: z.array(
            z.object({
              enum: z.array(z.string()).optional(),
              required: z.array(z.string()).optional(),
            }),
          ),
        }),
      }),
    })
    .parse(read('ErrorNotification.json'))
    .definitions.CodexErrorInfo.anyOf.flatMap(
      (branch) => branch.enum ?? branch.required ?? [],
    );
  assert.deepEqual(
    Object.keys(codexErrorRetryable).sort(),
    [...variants].sort(),
  );
  for (const name of variants) {
    const failure = codexTurnFailure(name);
    assert.deepEqual(
      [failure.class, failure.retryable],
      [name, codexErrorRetryable[name as keyof typeof codexErrorRetryable]],
    );
    // Object variants carry one key; the class is that key.
    assert.equal(
      codexTurnFailure({ [name]: { httpStatusCode: 503 } }).class,
      name,
    );
  }
});

test('an unknown, missing or ambiguous CodexErrorInfo is an unknown, non-retryable failure', () => {
  for (const info of [undefined, null, 'newVariant', {}, { a: 1, b: 2 }, 7])
    assert.deepEqual(codexTurnFailure(info), {
      class: 'unknown',
      retryable: false,
    });
  assert.deepEqual(codexTurnFailure('toString'), {
    class: 'unknown',
    retryable: false,
  });
});

test('a usage limit resets at the latest exhausted window of account/rateLimits/read (synthetic frame)', () => {
  const frame = read('usage-limit.synthetic.json');
  const failure = codexTurnFailure(frame.params.turn.error.codexErrorInfo);
  assert.deepEqual(failure, { class: 'usageLimitExceeded', retryable: true });
  assert.equal(limitClass(failure), true);
  assert.equal(resetAt(rateLimitsRead()), '2026-11-08T15:00:00.000Z');
  assert.equal(
    limitClass(codexTurnFailure('modelNotFound')),
    false,
    'only limit classes read rate limits',
  );
});

test('no exhausted window or an unparsable result has no reset time', () => {
  const open = rateLimitsRead();
  open.rateLimits.primary.usedPercent = 99;
  assert.equal(resetAt(open), undefined);
  assert.equal(resetAt(undefined), undefined);
  assert.equal(resetAt({ rateLimits: 'x' }), undefined);
  const spend = rateLimitsRead();
  spend.rateLimits.primary.usedPercent = 99;
  spend.rateLimits.individualLimit = {
    limit: '10',
    used: '10',
    remainingPercent: 0,
    resetsAt: 1794200000,
  };
  assert.equal(resetAt(spend), new Date(1794200000 * 1000).toISOString());
});

test('a JSON-RPC error keeps only its integer code', () => {
  assert.equal(rpcErrorCode({ code: -32600, message: 'secret' }), -32600);
  assert.equal(rpcErrorCode({ message: 'no code' }), undefined);
  assert.equal(rpcErrorCode('text'), undefined);
});
