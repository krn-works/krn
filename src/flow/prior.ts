// Bind a bounded prior record and the two-commit diff to mechanical verification.
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { changedPaths, validateSha } from './repository.ts';
import {
  deterministicCauses,
  type PriorReview,
  reviewRecordSchema,
} from './types.ts';

const recordByteLimit = 1024 * 1024;

export class PriorRecordError extends Error {
  constructor(message: string) {
    super(`--prior-record ${message}`);
    this.name = 'PriorRecordError';
  }
}

function readBoundedRecord(path: string): Buffer {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new PriorRecordError('must name a regular, non-symlink file');
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile())
      throw new PriorRecordError('must name a regular, non-symlink file');
    if (opened.size > recordByteLimit)
      throw new PriorRecordError('file exceeds 1 MB');
    const bytes = Buffer.alloc(recordByteLimit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > recordByteLimit)
      throw new PriorRecordError('file exceeds 1 MB');
    return bytes.subarray(0, length);
  } catch (error) {
    if (error instanceof PriorRecordError) throw error;
    throw new PriorRecordError(
      `cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function loadPriorReview(
  root: string,
  head: string,
  path: string,
): PriorReview {
  const bytes = readBoundedRecord(resolve(path));
  let text: string;
  try {
    text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new PriorRecordError('must contain valid UTF-8');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw new PriorRecordError('must contain valid JSON');
  }
  const parsed = reviewRecordSchema.safeParse(decoded);
  if (!parsed.success)
    throw new PriorRecordError(
      `does not match the review record schema: ${parsed.error.message}`,
    );
  const record = parsed.data;
  if (record.prior !== undefined)
    throw new PriorRecordError(
      'is already a second-round record; after two rounds the lead decides (override)',
    );
  let priorHead: string;
  let currentHead: string;
  let paths: string[];
  try {
    priorHead = validateSha(root, record.headSha.toLowerCase()).toLowerCase();
    currentHead = validateSha(root, head.toLowerCase()).toLowerCase();
  } catch (error) {
    throw new PriorRecordError(
      `cannot compare prior and current commits: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (priorHead === currentHead)
    throw new PriorRecordError('must have a different head SHA');
  if (
    record.panelVerdict !== 'FAIL' ||
    !(
      record.judges.some(
        (judge) => judge.state === 'complete' && judge.verdict === 'FAIL',
      ) ||
      (record.contracts !== undefined &&
        deterministicCauses(record.redFirst, record.contracts).some(
          ({ verdict }) => verdict === 'FAIL',
        ))
    )
  )
    throw new PriorRecordError(
      'requires a FAIL panel with a complete judge FAIL or deterministic failure',
    );
  try {
    paths = changedPaths(root, priorHead, currentHead);
  } catch (error) {
    throw new PriorRecordError(
      `cannot compare prior and current commits: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    headSha: priorHead,
    recordSha256: createHash('sha256').update(bytes).digest('hex'),
    findings: record.judges.flatMap((judge) =>
      judge.state === 'complete'
        ? judge.findings
            .filter(({ severity }) => severity === 'BLOCKING')
            .map(({ title, path, line, defect }) => ({
              role: judge.role,
              title,
              path,
              line,
              defect,
            }))
        : [],
    ),
    changedPaths: paths,
  };
}
