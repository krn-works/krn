// Reads the `krn-review:` comments of the last merged PRs through gh (read-only);
// the parsing lives in src/state/retro-evidence.ts.
import { ghSync } from '../repo/gh.ts';
import {
  type EvidenceItem,
  parseReviewComment,
} from '../state/retro-evidence.ts';

/** Reads the review comments of the last merged PRs through `gh` (read-only). */
export function readReviewComments(
  root: string,
  limit: number,
): EvidenceItem[] {
  const gh = (args: string[]) => ghSync(root, args);
  const list = gh([
    'pr',
    'list',
    '--state',
    'merged',
    '--limit',
    String(limit),
    '--json',
    'number',
    '--jq',
    '.[].number',
  ]);
  if (list.status !== 0) return [];
  return list.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((number) => {
      const comments = gh([
        'pr',
        'view',
        number,
        '--json',
        'comments',
        '--jq',
        '.comments[].body | @json',
      ]);
      if (comments.status !== 0) return [];
      return comments.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string)
        .filter((body) => body.startsWith('krn-review:'))
        .flatMap((body, round) =>
          parseReviewComment(body, Number(number), round + 1),
        );
    });
}
