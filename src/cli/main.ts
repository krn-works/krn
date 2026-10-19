#!/usr/bin/env node
// The CLI owns its name while unknown commands pass through to the configured legacy entry. ADR 0001.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ReviewCommandOutcome,
  ReviewUsageError,
  reviewCommand,
} from '../flow/cli.ts';
import { dispatch, reportJourneyCommand } from './index.ts';

const version = '0.1.0';
const recursionFlag = 'KRN_FORWARDED';

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function reviewOutcomeExitCode(outcome: ReviewCommandOutcome): number {
  switch (outcome) {
    case 'PASS':
    case 'OVERRIDE':
      return 0;
    case 'FAIL':
      return 1;
    case 'INCOMPLETE':
      return 2;
  }
}

export function reviewErrorExitCode(error: unknown): number {
  return error instanceof ReviewUsageError ? 64 : 70;
}

export function main(args = process.argv.slice(2)): void {
  if (args[0] === '--version') {
    process.stdout.write(`krn ${version}\n`);
    return;
  }

  if (args[0] === 'review') {
    void reviewCommand(args.slice(1))
      .then((outcome) => {
        if (outcome) process.exitCode = reviewOutcomeExitCode(outcome);
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = reviewErrorExitCode(error);
      });
    return;
  }

  if (args[0] === 'report' && args[1] === 'journey') {
    process.exitCode = reportJourneyCommand(args.slice(1));
    return;
  }

  if (args[0] === 'delegate') {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    void dispatch(args, {
      delegate: {
        signal: controller.signal,
        setExitCode: (code) => {
          process.exitCode = code;
        },
      },
    })
      .catch((error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 64;
      })
      .finally(() => {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      });
    return;
  }

  if (['start', 'checkpoint', 'stop', 'note'].includes(args[0] ?? '')) {
    void dispatch(args).catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 64;
    });
    return;
  }

  const legacyBin =
    process.env.KRN_LEGACY_ENTRY ||
    join(homedir(), '.codex/krn/current/scripts/krn.mjs');
  if (
    process.env[recursionFlag] === '1' ||
    canonical(legacyBin) === canonical(fileURLToPath(import.meta.url))
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

const invokedFrom = process.argv[1];
if (
  invokedFrom &&
  canonical(invokedFrom) === canonical(fileURLToPath(import.meta.url))
)
  main();
