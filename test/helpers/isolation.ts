import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import {
  decideIsolation,
  type IsolationCapabilities,
  type IsolationCapability,
} from '../../scripts/isolation-gate.mjs';

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
  process.stdout.write(`${decision.line}\n`);
  context.skip('isolation capability unavailable');
  return false;
}
