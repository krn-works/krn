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

export const capabilityNames: readonly IsolationCapability[];
export function selectIsolationTestFiles(
  root: string,
  testFileGlob: string,
): string[];
export function isolationFilesInSelection(
  root: string,
  selectedFiles: readonly string[],
  isolationFiles: readonly string[],
): string[];
