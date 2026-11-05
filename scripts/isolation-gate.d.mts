export type IsolationCapability = 'bwrap' | 'systemdUserScope' | 'go';
export type IsolationCapabilities = Record<
  Exclude<IsolationCapability, 'go'>,
  { available: boolean; reason: string }
> & { go?: { available: boolean; reason: string } };
export type IsolationDecision =
  | { kind: 'run' }
  | { kind: 'skip'; line: string }
  | { kind: 'fail'; message: string };
export function decideIsolation(
  testName: string,
  required: readonly IsolationCapability[],
  capabilities: Partial<IsolationCapabilities>,
  isCI: boolean,
): IsolationDecision;
export function isolationSummary(skipCount: number): string;
export function countIsolationSkips(output: string): number;
export function testSuiteExitCode(
  exitCode: number,
  skipCount: number,
  requireZeroSkips: boolean,
): number;
export function postGateStatusWhenClean(args: {
  exitCode: number;
  skipCount: number;
  post: () => void | Promise<void>;
}): Promise<boolean>;

export const capabilityNames: readonly IsolationCapability[];
export function resolveGoToolchain():
  | { root: string; binary: string }
  | undefined;
export function probeGoCapability(): { available: boolean; reason: string };
