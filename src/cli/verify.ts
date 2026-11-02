import {
  parseVerifyArgs,
  runVerify,
  VerifyDirtyTreeError,
  VerifyInternalError,
  VerifyUsageError,
} from '../verify/index.ts';

export async function verifyCommand(args: readonly string[]): Promise<void> {
  try {
    const result = await runVerify(parseVerifyArgs(args));
    for (const entry of result.lines)
      process.stdout.write(`${entry.step} ${entry.status} ${entry.detail}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    if (
      error instanceof VerifyUsageError ||
      error instanceof VerifyDirtyTreeError ||
      error instanceof VerifyInternalError
    )
      throw error;
    throw new VerifyInternalError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}
