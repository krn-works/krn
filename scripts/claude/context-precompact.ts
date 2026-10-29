import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hookInput } from './context-io.ts';

try {
  const input = hookInput(['PreCompact']);
  const result = spawnSync(
    process.execPath,
    [
      join(input.project, 'src/cli/main.ts'),
      'state',
      'check',
      '--root',
      input.project,
    ],
    { cwd: input.project, encoding: 'utf8', timeout: 20000 },
  );
  const directory = join(
    input.project,
    '.krn/runs/claude/context-gauge',
    input.sessionId,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'precompact.txt'),
    `stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}\nexit code: ${result.status ?? 'null'}\nsignal: ${result.signal ?? 'none'}\n`,
    { mode: 0o600 },
  );
} catch {
  /* Compaction must always continue. */
}
