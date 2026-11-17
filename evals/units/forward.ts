// Runs inside the install sandbox (egress.ts): listens on the sandbox's own loopback, pipes every connection to the
// host proxy's unix socket, runs `sh -c <cmd>` once listening, and exits with the command's status.
// Usage: node forward.ts <socket> <port> <cmd>

import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';

const [socket, port, cmd] = process.argv.slice(2);
if (!socket || !port || cmd === undefined) {
  process.stderr.write('usage: forward.ts <socket> <port> <cmd>\n');
  process.exit(64);
}

const server = createServer((c) => {
  const up = connect(socket);
  c.on('error', () => up.destroy());
  up.on('error', () => c.destroy());
  c.pipe(up);
  up.pipe(c);
});
server.on('error', (e) => {
  process.stderr.write(`forward: ${e.message}\n`);
  process.exit(70);
});
server.listen(Number(port), '127.0.0.1', () => {
  const child = spawn('sh', ['-c', cmd], { stdio: 'inherit' });
  child.on('error', () => process.exit(127));
  child.on('close', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
});
