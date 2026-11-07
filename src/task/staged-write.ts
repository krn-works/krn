import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

function stageWrite(
  root: string,
  target: string,
  contents: string | Buffer,
): string {
  const staging = stagingDirectory(root);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = stagedPath(staging, target);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o666);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function publishStagedWrite(
  temporary: string,
  target: string,
  replace = false,
): void {
  if (replace) renameSync(temporary, target);
  else linkSync(temporary, target);
}

function discardStagedWrite(temporary: string): void {
  if (existsSync(temporary)) unlinkSync(temporary);
}

export function atomicWrite(
  root: string,
  target: string,
  contents: string | Buffer,
  replace = false,
): void {
  const temporary = stageWrite(root, target, contents);
  try {
    publishStagedWrite(temporary, target, replace);
  } finally {
    discardStagedWrite(temporary);
  }
}

function stagingDirectory(root: string): string {
  const directory = join(root, '.krn', 'tmp', 'task-write');
  mkdirSync(directory, { recursive: true });
  return directory;
}

function stagedPath(directory: string, target: string): string {
  return join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
}
