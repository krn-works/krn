import { createHash } from 'node:crypto';
import type { NewReviewRecord } from '../flow/types.ts';
import { checked, type Runner } from './transport.ts';

const checklistPath = 'docs/program/hardening-checklist.md';

/** The head's immutable blob is the checklist a review must have used. */
export function requireReviewChecklist(
  record: Pick<
    NewReviewRecord,
    'base' | 'headSha' | 'checklist' | 'prepass' | 'prior'
  >,
  cwd: string,
  runner: Runner,
): void {
  try {
    if (
      ![record.base, record.headSha].every((sha) =>
        /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu.test(sha),
      )
    )
      throw new Error('base and head must be exact commit SHAs');
    const entry = (sha: string) =>
      checked(
        runner(
          'git',
          ['ls-tree', '--full-tree', sha, '--', checklistPath],
          cwd,
        ),
      );
    const base = entry(record.base);
    const head = entry(record.headSha);
    if (!base && !head) return;
    if (base && !head)
      throw new Error('head lacks the checklist; rebase onto the current base');
    // Round two may follow a checklist edit; the head-blob check below binds
    // the current round, so round one only has to have applied a checklist.
    if (
      record.prepass?.state !== 'complete' &&
      record.prior?.checklistSha256 === undefined
    )
      throw new Error('no judge completed review with the checklist');
    const match =
      /^(100644|100755) blob ([a-f\d]{40}|[a-f\d]{64})\tdocs\/program\/hardening-checklist\.md$/u.exec(
        head,
      );
    if (!match?.[2]) throw new Error('head must contain a regular blob');
    const size = Number(
      checked(runner('git', ['cat-file', '-s', match[2]], cwd)),
    );
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error('head checklist has an invalid blob size');
    if (size > 32 * 1024) throw new Error('head checklist exceeds 32768 bytes');
    const blob = runner('git', ['cat-file', 'blob', match[2]], cwd);
    checked(blob);
    const digest = createHash('sha256')
      .update(blob.stdoutBytes ?? Buffer.from(blob.stdout, 'utf8'))
      .digest('hex');
    if (record.checklist?.sha256 !== digest)
      throw new Error(
        'review checklist sha256 is missing or differs from the head blob',
      );
  } catch (error) {
    throw new Error(
      `${checklistPath}: ${error instanceof Error ? error.message : 'cannot verify checklist'}`,
      { cause: error },
    );
  }
}
