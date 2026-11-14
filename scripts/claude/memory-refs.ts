import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { memoryDirectory } from '../../src/memory/memory-directory.ts';
import {
  checkMemory,
  type Finding,
  safe,
} from '../../src/memory/memory-refs.ts';

function format(finding: Finding): string {
  const { kind, file, line, target } = finding;
  const location = [
    'UNINDEXED',
    'INDEX-SIZE',
    'TOO-LARGE',
    'UNREADABLE',
    'SUPERSEDED',
    'EXPIRED',
  ].includes(kind)
    ? safe(file)
    : `${safe(file)}:${line}`;
  return `${kind} ${location}${target ? ` ${safe(target)}` : ''}`;
}
function cli() {
  let root = process.cwd();
  let memory: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !['--root', '--memory'].includes(flag ?? '') ||
      !value ||
      value.startsWith('--')
    ) {
      process.stderr.write(
        'Usage: node scripts/claude/memory-refs.ts [--root <repository>] [--memory <directory>]\n',
      );
      process.exitCode = 64;
      return;
    }
    if (flag === '--root') root = resolve(value);
    else memory = resolve(value);
  }
  memory ??= memoryDirectory(root);
  try {
    const result = checkMemory({ root, memory });
    for (const finding of result.findings.slice(0, 200))
      console.log(format(finding));
    if (result.findings.length > 200)
      console.log(`... ${result.findings.length - 200} more`);
    console.log(
      `memory-refs: ${result.findings.length} findings in ${result.files} files`,
    );
    process.exitCode = result.findings.length ? 65 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'internal error';
    console.error(safe(message));
    process.exitCode = message.startsWith('memory directory not found:')
      ? 64
      : 70;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  cli();
