import { callRun } from './ledger.ts';

/**
 * True when the fix commit changes a line the earlier commit introduced:
 * `git blame` on the fix's parent over the old side of each changed hunk
 * names the earlier commit. Pure additions have no old lines, so they never
 * count. Any git failure (a commit not fetched locally) reads as not rework.
 */
export async function fixChangesIntroducedLines(
  root: string,
  introduced: string,
  fix: string,
  files: string[],
): Promise<boolean> {
  const git = (args: string[]) => callRun(30_000)('git', ['-C', root, ...args]);
  try {
    const diff = await git([
      'diff',
      '-U0',
      '--no-renames',
      `${fix}^`,
      fix,
      '--',
      ...files,
    ]);
    let file = '';
    for (const line of diff.split('\n')) {
      if (line.startsWith('--- ')) {
        file = line.slice(4).replace(/^a\//, '');
        continue;
      }
      const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
      if (!hunk || file === '/dev/null' || file === '') continue;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count === 0) continue;
      const blame = await git([
        'blame',
        '--porcelain',
        '-L',
        `${start},${start + count - 1}`,
        `${fix}^`,
        '--',
        file,
      ]);
      for (const row of blame.split('\n'))
        if (/^[0-9a-f]{40} /.test(row) && row.startsWith(introduced))
          return true;
    }
  } catch {
    return false;
  }
  return false;
}
