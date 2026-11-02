import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverCommand } from '../../src/deliver/cli.ts';
import { DeliveryFailure } from '../../src/deliver/delivery.ts';
import { CommandFailure } from '../../src/deliver/transport.ts';

test('deliver CLI reports a JSON ship refusal on stderr and preserves exit 76', async () => {
  const cause = new CommandFailure({
    code: 1,
    stdout: '{"ok":false,"reason":"review X"}\n',
    stderr: '',
  });
  const error = new DeliveryFailure('ship', cause);
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExitCode = process.exitCode;
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await deliverCommand(
      [
        '--repo',
        'krn-works/krn',
        '--pr',
        '138',
        '--record',
        'review.json',
        '--task',
        't-b6v615x',
        '--json',
      ],
      {
        deliver: async () => {
          throw error;
        },
      },
    );
    assert.equal(process.exitCode, 76);
    assert.match(stderr, /^review X\n$/u);
    const output = JSON.parse(stdout);
    assert.equal(output.status, 'failed');
    assert.equal(output.exitCode, 76);
    assert.equal(output.commandExitCode, 1);
    assert.equal(output.error, 'ship: review X');
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
  }
});
