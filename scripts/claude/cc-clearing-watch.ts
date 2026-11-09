import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Watches whether Claude Code's built-in tool-result clearing (t-mbrjeja)
// became reachable: GrowthBook environment overrides implemented, or a
// transcript that really carries a clear_tool_uses edit.

export type Facts = {
  overrides: 'null' | 'live' | 'absent';
  clearType: boolean;
  flag: boolean;
  idleSeconds: number | null;
};

export type Verdict = Facts & { version: string; transcriptHits: number };

const CHUNK = 8 * 2 ** 20;
const OVERLAP = 512;
const CLEAR_TYPE = 'clear_tool_uses_20250919';
const FLAG = 'tengu_jiggly_blossom';

// Chunked read with a tail carried between chunks; never holds the whole file.
export async function scanFile(path: string): Promise<Facts> {
  const facts: Facts = {
    overrides: 'absent',
    clearType: false,
    flag: false,
    idleSeconds: null,
  };
  let stubbed = 0;
  let live = 0;
  let tail = '';
  for await (const chunk of createReadStream(path, { highWaterMark: CHUNK })) {
    const text = tail + (chunk as Buffer).toString('latin1');
    // A match lying wholly inside the carried tail was seen last round.
    const from = tail.length > 0 ? Math.max(0, tail.length - 64) : 0;
    const fresh = text.slice(from);
    if (!facts.clearType && text.includes(CLEAR_TYPE)) facts.clearType = true;
    if (!facts.flag && text.includes(FLAG)) facts.flag = true;
    for (const m of fresh.matchAll(
      /getEnvironmentOverrides\(\)\{(return null\}|[^}]{0,80})/gu,
    )) {
      if (m[1] === 'return null}') stubbed += 1;
      else live += 1;
    }
    const idle = /minIdleSeconds:(\d+)/u.exec(text);
    if (idle?.[1] && facts.idleSeconds === null)
      facts.idleSeconds = Number(idle[1]);
    tail = text.slice(-OVERLAP);
  }
  facts.overrides = live > 0 ? 'live' : stubbed > 0 ? 'null' : 'absent';
  return facts;
}

export async function countTranscriptHits(
  dir: string,
  now = Date.now(),
  days = 7,
): Promise<number> {
  if (!existsSync(dir)) return 0;
  let hits = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(dir, name);
    if (now - statSync(file).mtimeMs > days * 86_400_000) continue;
    let tail = '';
    let found = false;
    for await (const chunk of createReadStream(file, {
      highWaterMark: CHUNK,
    })) {
      const text = tail + (chunk as Buffer).toString('utf8');
      if (
        text.includes(`"type":"${CLEAR_TYPE}"`) &&
        text.includes('applied_edits')
      )
        found = true;
      tail = text.slice(-OVERLAP);
      if (found) break;
    }
    if (found) hits += 1;
  }
  return hits;
}

// Unreachable means: overrides stubbed, no live edit in transcripts.
export function changed(v: Verdict): boolean {
  return v.overrides !== 'null' || v.transcriptHits > 0;
}

export function line(v: Verdict): string {
  return [
    `claude ${v.version}`,
    `getEnvironmentOverrides=${v.overrides}`,
    `${CLEAR_TYPE}=${v.clearType ? 'present' : 'absent'}`,
    `${FLAG}=${v.flag ? 'present' : 'absent'}`,
    `idle=${v.idleSeconds ?? 'unknown'}s`,
    `transcript_edits_7d=${v.transcriptHits}`,
    changed(v) ? 'CHANGED: revisit t-mbrjeja' : 'unchanged',
  ].join(' ');
}

export function resolveBinary(path = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(delimiter)) {
    const candidate = join(dir, 'claude');
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return null;
}

export function versionOf(binary: string): string {
  const dirName = basename(dirname(binary));
  return /^\d+\.\d+\.\d+/u.test(dirName)
    ? dirName
    : `${basename(binary)}-${statSync(binary).size}`;
}

function readCache(file: string): Verdict | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Verdict;
  } catch {
    return null;
  }
}

// hook: print only when the verdict is new-and-changed or differs from the
// cached one; the binary scan is cached per version, transcripts are not.
export async function run(options: {
  cacheDir: string;
  transcripts: string;
  hook: boolean;
  binary?: string | null;
}): Promise<{ output: string; code: number }> {
  const binary =
    options.binary === undefined ? resolveBinary() : options.binary;
  if (!binary) return { output: 'claude binary not found on PATH', code: 1 };
  const version = versionOf(binary);
  const file = join(options.cacheDir, `${version}.json`);
  const cached = readCache(file);
  const facts = cached ?? (await scanFile(binary));
  const transcriptHits =
    options.hook && cached
      ? cached.transcriptHits
      : await countTranscriptHits(options.transcripts);
  const verdict: Verdict = { ...facts, version, transcriptHits };
  mkdirSync(options.cacheDir, { recursive: true });
  writeFileSync(file, JSON.stringify(verdict));
  const code = changed(verdict) ? 1 : 0;
  if (!options.hook) return { output: line(verdict), code };
  const differs =
    cached === null ||
    changed(cached) !== changed(verdict) ||
    cached.overrides !== verdict.overrides;
  if (cached === null && !changed(verdict))
    return {
      output: `cc-watch: new claude ${version} scanned, still unreachable`,
      code: 0,
    };
  return { output: differs ? `cc-watch: ${line(verdict)}` : '', code: 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const { output, code } = await run({
    cacheDir: join(root, '.krn', 'runs', 'cc-watch'),
    transcripts: join(
      homedir(),
      '.claude',
      'projects',
      '-mnt-storage-coding-krn-active-krn',
    ),
    hook: process.argv.includes('--hook'),
  });
  if (output) console.log(output);
  process.exit(process.argv.includes('--hook') ? 0 : code);
}
