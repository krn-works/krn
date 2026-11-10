import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  subagentFiles,
  transcriptDirs,
  transcriptFiles,
  transcriptLines,
} from '../../src/harness/transcripts.ts';

test('transcriptDirs finds the root and its worktree project directories only', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'krn-projects-'));
  try {
    for (const name of [
      '-r-krn',
      '-r-krn--krn-worktrees-lane-a',
      '-r-krn--krn-worktrees-lane-b',
      '-r-krn-betting',
      '-r-krn--claude-worktrees-x',
      '-other',
    ])
      await mkdir(join(projects, name));
    const dirs = await transcriptDirs('/r/krn', projects);
    assert.deepEqual(
      dirs.map((d: string) => d.slice(projects.length + 1)),
      [
        '-r-krn',
        '-r-krn--krn-worktrees-lane-a',
        '-r-krn--krn-worktrees-lane-b',
      ],
    );
    assert.deepEqual(await transcriptDirs('/r/krn', join(projects, 'none')), [
      join(projects, 'none', '-r-krn'),
    ]);
  } finally {
    await rm(projects, { recursive: true, force: true });
  }
});

test('transcript files, subagents and lines come from one reader', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'krn-transcripts-'));
  try {
    await writeFile(join(dir, 'b.jsonl'), '{"a":1}\r\n{"b":2}\n');
    await writeFile(join(dir, 'a.jsonl'), '');
    await writeFile(join(dir, 'note.txt'), 'x');
    await mkdir(join(dir, 'a', 'subagents'), { recursive: true });
    await writeFile(join(dir, 'a', 'subagents', 'agent-1.jsonl'), '');
    await writeFile(
      join(dir, 'a', 'subagents', 'agent-1.meta.json'),
      '{"agentType":"x"}',
    );
    await writeFile(join(dir, 'a', 'subagents', 'agent-2.jsonl'), '');
    const files = await transcriptFiles([dir, join(dir, 'missing')]);
    assert.deepEqual(files.map((f) => f.id).sort(), ['a', 'b']);
    const subs = await subagentFiles(join(dir, 'a.jsonl'));
    assert.deepEqual(subs.map((s) => [s.id, s.meta]).sort(), [
      ['agent-1', '{"agentType":"x"}'],
      ['agent-2', ''],
    ]);
    const lines: string[] = [];
    for await (const line of transcriptLines(join(dir, 'b.jsonl')))
      lines.push(line);
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no source outside src/harness reads transcript files', async () => {
  const src = new URL('../../src/', import.meta.url).pathname;
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(path)));
      else if (e.name.endsWith('.ts')) out.push(path);
    }
    return out;
  };
  const readers: string[] = [];
  for (const file of await walk(src)) {
    if (file.startsWith(join(src, 'harness'))) continue;
    const text = await readFile(file, 'utf8');
    if (/\.claude\/projects|createInterface|['"`]subagents['"`]/u.test(text))
      readers.push(file.slice(src.length));
  }
  assert.deepEqual(readers, []);
});
