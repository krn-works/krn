import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

// A rule over every src module, so npm run fast runs it on any change (rule tests always run):
// as a harness test it was skipped when a new src module read transcripts.
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
  // Modules that read the transcript a hook payload names (agent_transcript_path, transcript_path);
  // each is listed on purpose, so a new reader fails here until it is reviewed and added.
  const hookPayloadReaders = new Set([
    'cli/doctor-hooks.ts',
    'context/gauge.ts',
    'context/replay.ts',
    'context/restart.ts',
    'hook/outcome-judge.ts',
    'hook/session-standards.ts',
    'hook/session-start.ts',
    'hook/stop.ts',
    // Lanes with no manifest only (ADR 0029 step 7 deletes it).
    'lane/legacy.ts',
    'memory/identifier-index.ts',
    'memory/operator-inbox-store.ts',
    'successor/operator-inbox.ts',
  ]);
  const payloadReaders: string[] = [];
  const readers: string[] = [];
  for (const file of await walk(src)) {
    if (file.startsWith(join(src, 'harness'))) continue;
    const text = await readFile(file, 'utf8');
    if (/agent_transcript_path|\btranscript_path\b|transcriptPath/u.test(text))
      payloadReaders.push(file.slice(src.length));
    if (/\.claude\/projects|createInterface|['"`]subagents['"`]/u.test(text))
      readers.push(file.slice(src.length));
  }
  assert.deepEqual(readers, []);
  assert.deepEqual(
    payloadReaders.filter((file) => !hookPayloadReaders.has(file)),
    [],
  );
  // stop.ts reads transcripts in five places; the rule must see it.
  assert.ok(payloadReaders.includes('hook/stop.ts'));
});
