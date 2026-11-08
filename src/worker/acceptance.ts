import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { workerEnvironment } from '../hosts/codex.ts';
import { redact, secureDir } from './state.ts';
import { workerTmp } from './trust.ts';

type Acceptance = {
  kind: 'check' | 'observer';
  cmd: string;
  exit_code: number | null;
  timed_out: boolean;
  log: string;
};
const outputLimit = 1048576;
// Output is captured up to twice the log limit and redacted before the cut,
// so a secret that straddles the log limit is matched as a whole.
const captureLimit = 2 * outputLimit;
const timeout = () => {
  const value = Number(process.env.KRN_WORKER_CHECK_TIMEOUT_MS ?? 600000);
  return Number.isInteger(value) && value >= 1 && value <= 600000
    ? value
    : 600000;
};
export async function runAcceptance(
  repo: string,
  run: string,
  roundDir: string,
  checks: string[],
  observers: string[],
  executable: string,
): Promise<Acceptance[]> {
  const entries = [
    ...checks.map((cmd) => ({
      kind: 'check' as const,
      cmd,
      argv: ['sh', '-c', cmd],
    })),
    ...observers.map((cmd) => ({
      kind: 'observer' as const,
      cmd,
      argv: [process.execPath, '--test', cmd],
    })),
  ];
  const results: Acceptance[] = [];
  for (const [i, entry] of entries.entries()) {
    const result: Acceptance = {
      kind: entry.kind,
      cmd: entry.cmd,
      exit_code: null,
      timed_out: false,
      log: `acceptance-${i + 1}.log`,
    };
    let missing = false;
    if (entry.kind === 'observer') {
      try {
        secureDir(join(repo, entry.cmd, '..'), false);
        missing = !lstatSync(join(repo, entry.cmd)).isFile();
      } catch {
        missing = true;
      }
    }
    secureDir(roundDir, false);
    const fd = openSync(
      join(roundDir, result.log),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const collect = (chunk: Buffer) => {
      const part = chunk.subarray(0, Math.max(0, captureLimit - bytes));
      if (part.length) chunks.push(part);
      bytes += part.length;
      if (part.length < chunk.length) truncated = true;
    };
    try {
      if (missing) {
        collect(Buffer.from(`missing observer ${entry.cmd}\n`));
      } else {
        const args = [
          'sandbox',
          '-c',
          'sandbox_mode="workspace-write"',
          '-c',
          `sandbox_workspace_write.writable_roots=[${JSON.stringify(repo)},${JSON.stringify(workerTmp(run))}]`,
          '-c',
          'sandbox_workspace_write.network_access=true',
          '--',
          ...entry.argv,
        ];
        await new Promise<void>((done) => {
          const child = spawn(executable, args, {
            cwd: repo,
            env: { ...workerEnvironment(), TMPDIR: workerTmp(run) },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          child.stdout.on('data', collect);
          child.stderr.on('data', collect);
          const timer = setTimeout(() => {
            result.timed_out = true;
            if (child.pid) {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                /* Already exited. */
              }
            }
          }, timeout());
          child.once('error', () => {
            result.exit_code = 127;
          });
          child.once('close', (code) => {
            clearTimeout(timer);
            result.exit_code = result.timed_out
              ? 124
              : (result.exit_code ?? code ?? 1);
            done();
          });
        });
      }
      const output = Buffer.from(
        withoutOpenKey(redact(Buffer.concat(chunks).toString('utf8'))),
      );
      const marker = '\n[truncated at 1048576 bytes]\n';
      if (truncated || output.length > outputLimit) {
        writeFileSync(
          fd,
          output.subarray(0, outputLimit - Buffer.byteLength(marker)),
        );
        writeFileSync(fd, marker);
      } else {
        writeFileSync(fd, output);
      }
    } finally {
      closeSync(fd);
    }
    results.push(result);
  }
  return results;
}

// A private key whose END line lies beyond the captured output cannot be
// matched by redact(); drop everything from its unterminated BEGIN line.
function withoutOpenKey(text: string): string {
  const open =
    /-----BEGIN ([A-Z ]*PRIVATE KEY)-----(?![\s\S]*-----END \1-----)/.exec(
      text,
    );
  return open ? `${text.slice(0, open.index)}[redacted]` : text;
}
