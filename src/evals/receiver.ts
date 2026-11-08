import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EvalDataError } from './manifest.ts';

// Codex versions whose exec --json stream was captured under
// test/fixtures/eval/codex-<version>; a test keeps the two equal.
export const CAPTURED_CODEX_VERSIONS: readonly string[] = ['0.167.0'];

const run = promisify(execFile);

/** The `codex --version` line of a captured receiver, refusing any other. */
export async function capturedCodexVersion(binary: string): Promise<string> {
  let line: string;
  try {
    const { stdout } = await run(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    line = stdout.trim();
  } catch (error) {
    throw new EvalDataError(
      `cannot read codex --version: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const version = /^codex-cli (\S+)$/.exec(line)?.[1];
  if (!version || !CAPTURED_CODEX_VERSIONS.includes(version))
    throw new EvalDataError(
      `codex reports ${JSON.stringify(line)}; captured receiver versions: ${CAPTURED_CODEX_VERSIONS.join(', ')} (record captures with scripts/evals/capture-codex.ts)`,
    );
  return line;
}
