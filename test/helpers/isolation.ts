import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { z } from 'zod';
import {
  decideIsolation,
  type IsolationCapabilities,
  type IsolationCapability,
} from '../../scripts/isolation-gate.mjs';

const isolationSkipFileEnvSchema = z
  .object({
    file: z.string().min(1),
    nonce: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export function requiresIsolation(
  context: TestContext,
  testName: string,
  required: readonly IsolationCapability[],
): boolean {
  const raw = process.env.KRN_ISOLATION_CAPABILITIES;
  assert.ok(raw, 'isolation capability probe did not run');
  let capabilities: IsolationCapabilities;
  try {
    capabilities = JSON.parse(raw) as IsolationCapabilities;
  } catch {
    assert.fail('isolation capability probe returned invalid JSON');
  }
  const decision = decideIsolation(
    testName,
    required,
    capabilities,
    process.env.CI === 'true',
  );
  if (decision.kind === 'run') return true;
  if (decision.kind === 'fail') assert.fail(decision.message);
  const parsedSkipFile = isolationSkipFileEnvSchema.safeParse({
    file: process.env.KRN_ISOLATION_SKIP_FILE,
    nonce: process.env.KRN_ISOLATION_SKIP_NONCE,
  });
  assert.ok(
    parsedSkipFile.success,
    'test runner did not provide a valid isolation skip side channel',
  );
  appendFileSync(
    parsedSkipFile.data.file,
    `${JSON.stringify({
      nonce: parsedSkipFile.data.nonce,
      testName,
      line: decision.line,
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  process.stdout.write(`${decision.line}\n`);
  context.skip(decision.line);
  return false;
}
