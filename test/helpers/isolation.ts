import { createRequire } from 'node:module';
import type { TestContext } from 'node:test';

export type IsolationCapability = 'bwrap' | 'systemdUserScope';
type Capabilities = Record<
  IsolationCapability,
  { available: boolean; reason?: string }
>;

const require = createRequire(import.meta.url);
const { probeIsolationCapabilities } =
  require('../../scripts/probe-isolation.mjs') as {
    probeIsolationCapabilities: () => Capabilities;
  };

const labels: Record<IsolationCapability, string> = {
  bwrap: 'bwrap user namespaces',
  systemdUserScope: 'systemd user scopes',
};

let capabilities: Capabilities | undefined;

/** Live sandbox tests need the real capability; a missing one fails loudly. */
export function requiresIsolation(
  _context: TestContext,
  testName: string,
  required: readonly IsolationCapability[],
): boolean {
  capabilities ??= process.env.KRN_ISOLATION_CAPABILITIES
    ? (JSON.parse(process.env.KRN_ISOLATION_CAPABILITIES) as Capabilities)
    : probeIsolationCapabilities();
  const missing = required.filter((name) => !capabilities?.[name]?.available);
  if (missing.length > 0)
    throw new Error(
      `Isolation requirements failed for ${testName}: missing ${missing.map((name) => labels[name]).join(', ')}`,
    );
  return true;
}
