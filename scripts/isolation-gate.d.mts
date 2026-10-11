export type IsolationCapability = 'bwrap' | 'systemdUserScope';
export type IsolationCapabilities = Record<
  IsolationCapability,
  { available: boolean; reason: string }
>;
export type IsolationDecision =
  | { kind: 'run' }
  | { kind: 'skip'; line: string }
  | { kind: 'fail'; message: string };
export type TapSummary = {
  testCount: number | undefined;
  skippedCount: number | undefined;
  todoCount: number | undefined;
  isolationSkipNames: string[];
};
export function decideIsolation(
  testName: string,
  required: readonly IsolationCapability[],
  capabilities: IsolationCapabilities,
  isCI: boolean,
): IsolationDecision;
export function isolationSummary(skipNames: readonly string[]): string;
export function countIsolationSkips(output: string): number;
export function parseTapSummary(output: string): TapSummary;
export function testSuiteExitCode(
  exitCode: number,
  summary: TapSummary,
  requireZeroSkips: boolean,
  isCI: boolean,
): number;
export function postGateStatusWhenClean(args: {
  exitCode: number;
  skipCount: number;
  post: () => void | Promise<void>;
}): Promise<boolean>;
