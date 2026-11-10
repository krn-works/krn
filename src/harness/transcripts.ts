import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { createInterface } from 'node:readline';

/** The only reader of agent-harness transcript files: locates them and iterates their lines. */

/** One top-level transcript with the files that hang off it. */
export type TranscriptFile = {
  path: string;
  /** Transcript file name without extension. */
  id: string;
};

/** Subagent transcript of a lead transcript, with its metadata file text ('' when absent). */
export type SubagentFile = TranscriptFile & { meta: string };

const EXTENSION = '.jsonl';

async function jsonlFiles(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(EXTENSION))
      .map((e) => join(path, e.name));
  } catch {
    return [];
  }
}

const idOf = (path: string): TranscriptFile => ({
  path,
  id: basename(path, EXTENSION),
});

/** Top-level transcripts in the given directories, in directory then name order. */
export async function transcriptFiles(
  directories: string[],
): Promise<TranscriptFile[]> {
  return (await Promise.all(directories.map(jsonlFiles))).flat().map(idOf);
}

/** A lead transcript's subagent transcripts, each with its raw metadata text. */
export async function subagentFiles(lead: string): Promise<SubagentFile[]> {
  const subs = await jsonlFiles(
    join(lead.slice(0, -EXTENSION.length), 'subagents'),
  );
  return Promise.all(
    subs.map(async (path) => {
      let meta = '';
      try {
        meta = await readFile(
          `${path.slice(0, -EXTENSION.length)}.meta.json`,
          'utf8',
        );
      } catch {
        /* A subagent without metadata keeps an unknown role. */
      }
      return { ...idOf(path), meta };
    }),
  );
}

/** Stream a transcript's lines; rejects when the file cannot be read. */
export function transcriptLines(path: string): AsyncIterable<string> {
  return createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
}

/**
 * Claude project directories whose session cwd is the root or one of its
 * `.krn/worktrees/*` checkouts: the root-derived name plus its
 * `--krn-worktrees-` variants (a sibling such as `<root>-betting` never matches).
 */
export async function transcriptDirs(
  root: string,
  projects = join(homedir(), '.claude/projects'),
): Promise<string[]> {
  const base = root.replaceAll(sep, '-');
  const worktrees = `${base}--krn-worktrees-`;
  let names: string[] = [];
  try {
    names = (await readdir(projects)).filter(
      (n) => n === base || n.startsWith(worktrees),
    );
  } catch {
    names = [base];
  }
  return names.sort().map((n) => join(projects, n));
}
