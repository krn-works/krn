// The repository's reviewer for `krn pr ship` (krn.json `review`): fresh-context Codex runs, one per
// diff chunk and in parallel, each told only the diff range and its files; findings merge into one file.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** Changed lines one reviewer reads; a larger diff splits by file into chunks of about this size. */
const CHUNK_LINES = 400;
const MAX_CHUNKS = 6;

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'evidence', 'reproduce', 'class'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          reproduce: { type: 'string' },
          class: { type: 'string' },
        },
      },
    },
  },
};
const answer = z.object({
  findings: z.array(z.object({ id: z.string() }).passthrough()),
});

/** Files of a `git diff --numstat` text grouped into chunks of about CHUNK_LINES changed lines. */
export function chunks(numstat: string): string[][] {
  const groups: string[][] = [];
  let lines = 0;
  for (const row of numstat.split('\n')) {
    const [added, deleted, path] = row.split('\t');
    if (path === undefined || /^tasks\/[^/]+\.json$/u.test(path)) continue;
    const size = (Number(added) || 0) + (Number(deleted) || 0);
    const last = groups.at(-1);
    if (last === undefined || (lines + size > CHUNK_LINES && lines > 0)) {
      groups.push([path]);
      lines = size;
    } else {
      last.push(path);
      lines += size;
    }
  }
  // Past the cap the tail chunks merge into the last one: every file is still read.
  while (groups.length > MAX_CHUNKS) {
    const tail = groups.pop() ?? [];
    groups.at(-1)?.push(...tail);
  }
  return groups;
}

/** The instructions one chunk reviewer gets: the range and its files, nothing of the author's intent. */
export function prompt(base: string, head: string, files: string[]): string {
  return [
    `You review one change in this repository with fresh eyes. The change is \`git diff ${base}...${head}\`; your share is these files: ${files.join(', ')}. Read their diff and whatever code they touch or call. You know nothing of the author's intent beyond the diff.`,
    'Report only correctness defects the change introduces or makes reachable: an input or state that gives a wrong result, a crash, or a check that passes when it must fail. No style, naming or suggestions.',
    'For each defect give: id (short slug); title (one English sentence: input -> wrong outcome); evidence (list of "path:line" in the changed code); reproduce (one shell command run from the repository root that exits non-zero while the defect exists and 0 once it is fixed, e.g. `node --test .krn/tmp/review/<name>.test.ts`); class (receiver-state, untested-branch, ambient-host, unenumerated-callers, stub-mismatch, gate-self or other).',
    'Write reproduction files only under .krn/tmp/review/. An empty findings list is the right answer when you find nothing you can reproduce.',
  ].join('\n');
}

function reviewChunk(
  index: number,
  files: string[],
  base: string,
  head: string,
  dir: string,
): Promise<{ id: string }[]> {
  const schemaFile = join(dir, 'schema.json');
  const out = join(dir, `chunk-${index}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      'codex',
      [
        'exec',
        '--ephemeral',
        '--sandbox',
        'workspace-write',
        '--output-schema',
        schemaFile,
        '--output-last-message',
        out,
        '-',
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-1000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`chunk ${index}: codex exited ${code}: ${stderr}`));
        return;
      }
      try {
        const parsed = answer.parse(JSON.parse(readFileSync(out, 'utf8')));
        resolve(
          parsed.findings.map((finding) => ({
            ...finding,
            id: `c${index}-${finding.id}`,
          })),
        );
      } catch (error) {
        reject(new Error(`chunk ${index}: ${(error as Error).message}`));
      }
    });
    child.stdin.end(prompt(base, head, files));
  });
}

async function main(): Promise<void> {
  const { KRN_REVIEW_BASE: base, KRN_REVIEW_HEAD: head } = process.env;
  const target = process.env.KRN_REVIEW_OUT;
  if (!base || !head || !target) {
    process.stderr.write(
      'review-diff: KRN_REVIEW_BASE, KRN_REVIEW_HEAD and KRN_REVIEW_OUT are required (krn pr ship sets them)\n',
    );
    process.exit(64);
  }
  const numstat = spawnSync('git', ['diff', '--numstat', '--no-renames', `${base}...${head}`], {
    encoding: 'utf8',
  });
  if (numstat.status !== 0) {
    process.stderr.write(`review-diff: git diff failed: ${numstat.stderr}\n`);
    process.exit(70);
  }
  const dir = join('.krn', 'tmp', 'review-diff');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'schema.json'), JSON.stringify(schema));
  const groups = chunks(numstat.stdout);
  const results = await Promise.allSettled(
    groups.map((files, index) => reviewChunk(index, files, base, head, dir)),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    for (const r of failed)
      process.stderr.write(`review-diff: ${String(r.reason)}\n`);
    process.exit(70);
  }
  const findings = results.flatMap((r) =>
    r.status === 'fulfilled' ? r.value : [],
  );
  writeFileSync(target, `${JSON.stringify({ findings }, null, 2)}\n`);
  process.stdout.write(
    `review-diff: ${groups.length} chunk(s), ${findings.length} finding(s)\n`,
  );
}

if (import.meta.main) await main();
