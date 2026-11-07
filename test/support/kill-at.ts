import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Runs `body` in a child node process in which `fnName` of node:fs blocks
 * forever (after printing "reached") the first time it is called, then
 * SIGKILLs the child by PID once it is parked there. `body` is module source
 * evaluated after the patch; it should import the receiver under test.
 */
export async function killAtFsCall(
  fnName: string,
  body: string,
): Promise<{ pid: number; signal: NodeJS.Signals | null }> {
  const source = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const real = fs[${JSON.stringify(fnName)}];
fs[${JSON.stringify(fnName)}] = (...args) => {
  fs.writeSync(1, 'reached\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  return real(...args);
};
syncBuiltinESMExports();
${body}
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const pid = child.pid as number;
  const closed = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once('close', (_code, signal) => resolve(signal)),
  );
  await new Promise<void>((resolve, reject) => {
    let seen = '';
    child.stdout.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes('reached')) resolve();
    });
    child.once('close', () => reject(new Error('child exited before fault')));
  });
  process.kill(pid, 'SIGKILL');
  return { pid, signal: await closed };
}
