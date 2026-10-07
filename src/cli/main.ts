#!/usr/bin/env node
// The CLI owns its name while unknown commands pass through to the configured legacy entry. ADR 0001.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '0.1.0';
const recursionFlag = 'KRN_FORWARDED';

export function main(args = process.argv.slice(2)): void {
  if (args[0] === '--version') {
    process.stdout.write(`krn ${version}\n`);
    return;
  }

  const legacyBin = process.env.KRN_LEGACY_BIN;
  if (!legacyBin) {
    process.stderr.write(
      'Unknown command; set KRN_LEGACY_BIN to enable legacy forwarding.\n',
    );
    process.exitCode = 64;
    return;
  }

  if (
    process.env[recursionFlag] === '1' ||
    resolve(legacyBin) === fileURLToPath(import.meta.url)
  ) {
    process.stderr.write('Legacy forwarding recursion blocked.\n');
    process.exitCode = 70;
    return;
  }

  const child = spawn(process.execPath, [legacyBin, ...args], {
    env: { ...process.env, [recursionFlag]: '1' },
    stdio: 'inherit',
  });
  child.once('error', () => {
    process.stderr.write(`Unable to start legacy command: ${legacyBin}\n`);
    process.exitCode = 127;
  });
  child.once('close', (code, signal) => {
    if (code !== null) process.exitCode = code;
    else if (signal) process.exitCode = 128;
    else process.exitCode ??= 1;
  });
}

main();
