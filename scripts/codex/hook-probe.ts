import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { object } from '../claude/context-io.ts';

// Live probe of the project's Codex hooks: runs real `codex exec` sessions in
// a trusted KRN checkout and prints one PASS/FAIL line per hook event. It reads
// the rollout, not the model's answer, because Codex refuses to quote developer
// messages; hook output is a developer message whose content_item_kinds holds
// hooks.additional_context. Usage: node scripts/codex/hook-probe.ts [--root <dir>]
// [--skip-advisory]. The advisory step sends a ~630 KB prompt, so it costs
// one large request.

export type Injection = { turn: string | undefined; text: string };

export type Turns = {
  last: string | undefined;
  compactions: number;
  injections: Injection[];
};

export function rolloutTurns(rollout: string): Turns {
  let last: string | undefined;
  let compactions = 0;
  const injections: Injection[] = [];
  for (const line of rollout.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = object(JSON.parse(line));
    } catch {
      continue;
    }
    const payload = object(entry.payload ?? {});
    if (entry.type === 'compacted') compactions++;
    if (entry.type === 'event_msg' && payload.type === 'task_started')
      last = typeof payload.turn_id === 'string' ? payload.turn_id : last;
    if (entry.type !== 'response_item' || payload.role !== 'developer')
      continue;
    const meta = object(
      payload.internal_chat_message_metadata_passthrough ?? {},
    );
    const kinds = meta.content_item_kinds;
    if (!Array.isArray(kinds) || !kinds.includes('hooks.additional_context'))
      continue;
    const content = Array.isArray(payload.content) ? payload.content : [];
    for (const item of content) {
      const text = object(item).text;
      if (typeof text === 'string')
        injections.push({
          turn: typeof meta.turn_id === 'string' ? meta.turn_id : undefined,
          text,
        });
    }
  }
  return { last, compactions, injections };
}

const restart = /^Branch: /u;
const advisoryText = /^Context at \d+k \(KRN advisory/u;

// Restart blocks injected into the rollout's final turn: exactly one per
// SessionStart turn, whatever sources Codex drained in it.
export function restartBlocks(turns: Turns): number {
  return turns.injections.filter(
    (item) => item.turn === turns.last && restart.test(item.text),
  ).length;
}

export function advisories(turns: Turns): number {
  return turns.injections.filter(
    (item) => item.turn === turns.last && advisoryText.test(item.text),
  ).length;
}

export type Verdict = { event: string; pass: boolean; detail: string };

export function line(verdict: Verdict): string {
  return `${verdict.pass ? 'PASS' : 'FAIL'} ${verdict.event}: ${verdict.detail}`;
}

function rolloutPath(threadId: string): string {
  const root = join(
    process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    'sessions',
  );
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith(`${threadId}.jsonl`)) return path;
    }
  }
  throw new Error(`No rollout for thread ${threadId}`);
}

const quiet = 'Do not run tools. Reply with the single word DONE.';

function codex(root: string, args: string[], input?: string): string {
  const output = execFileSync('codex', ['exec', '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    input: input ?? '',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  for (const raw of output.split('\n')) {
    if (!raw.trim()) continue;
    const event = object(JSON.parse(raw));
    if (event.type === 'thread.started' && typeof event.thread_id === 'string')
      return event.thread_id;
  }
  throw new Error(`codex exec ${args[0]} printed no thread id`);
}

function turns(threadId: string): { path: string; turns: Turns } {
  const path = rolloutPath(threadId);
  return { path, turns: rolloutTurns(readFileSync(path, 'utf8')) };
}

function probe(root: string, advisory: boolean): Verdict[] {
  const verdicts: Verdict[] = [];
  const started = Date.now();
  const thread = codex(root, [quiet]);
  const start = turns(thread);
  const startBlocks = restartBlocks(start.turns);
  verdicts.push({
    event: 'SessionStart startup',
    pass: startBlocks === 1,
    detail: `${startBlocks} restart block(s) in the turn; ${start.path}`,
  });

  codex(root, [
    'resume',
    thread,
    '-c',
    'model_auto_compact_token_limit=20000',
    quiet,
  ]);
  const compact = turns(thread);
  const compactBlocks = restartBlocks(compact.turns);
  verdicts.push({
    event: 'SessionStart resume+compact',
    pass: compact.turns.compactions > 0 && compactBlocks === 1,
    detail: `${compact.turns.compactions} compaction(s), ${compactBlocks} restart block(s) in the turn`,
  });
  const receipt = join(root, '.krn/runs/codex/precompact', `${thread}.json`);
  const fresh = existsSync(receipt) && statSync(receipt).mtimeMs >= started;
  verdicts.push({
    event: 'PreCompact',
    pass: fresh,
    detail: fresh ? receipt : 'no receipt written during the probe',
  });

  const forked = codex(root, ['fork', thread, quiet]);
  const fork = turns(forked);
  const forkBlocks = restartBlocks(fork.turns);
  verdicts.push({
    event: 'SessionStart fork',
    pass: forkBlocks === 1,
    detail: `${forkBlocks} restart block(s) in the turn; ${fork.path}`,
  });

  if (advisory) {
    const filler = 'This line is filler for a context probe; ignore it.\n';
    const big = codex(
      root,
      ['-'],
      `${filler.repeat(Math.ceil(630000 / filler.length))}${quiet}\n`,
    );
    codex(root, ['resume', big, quiet]);
    const gauge = turns(big);
    const count = advisories(gauge.turns);
    verdicts.push({
      event: 'UserPromptSubmit advisory',
      pass: count === 1,
      detail: `${count} advisory block(s) in the turn; ${gauge.path}`,
    });
  }
  return verdicts;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--root');
  const root = at >= 0 ? (args[at + 1] ?? '') : process.cwd();
  let verdicts: Verdict[];
  try {
    verdicts = probe(root, !args.includes('--skip-advisory'));
  } catch (error) {
    verdicts = [
      {
        event: 'probe',
        pass: false,
        detail: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  for (const verdict of verdicts) console.log(line(verdict));
  process.exitCode = verdicts.every((verdict) => verdict.pass) ? 0 : 1;
}
