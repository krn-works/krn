export type IsolationCapability = 'bwrap' | 'systemdUserScope';
export type IsolationCapabilities = Record<
  IsolationCapability,
  { available: boolean; reason: string }
>;
export type IsolationDecision =
  | { kind: 'run' }
  | { kind: 'skip'; line: string }
  | { kind: 'fail'; message: string };
export function decideIsolation(
  testName: string,
  required: readonly IsolationCapability[],
  capabilities: IsolationCapabilities,
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
