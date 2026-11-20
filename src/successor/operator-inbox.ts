// Operator inbox CLI.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  allEntries,
  capture,
  dispose,
  oneLine,
  openEntries,
  promptOrigin,
} from '../memory/operator-inbox-store.ts';
import { pendingTaskFiles } from '../task/pending.ts';
import { isTaskId, TaskDataError } from '../task/record.ts';
import { hasTask } from '../task/store.ts';

// The operator-inbox command: capture hook input, list open prompts, dispose one, search mentions.
// run() returns the exit code; scripts/claude/operator-inbox.ts only wires argv, stdin and the streams.

export const usage = `Usage:
  operator-inbox.ts capture            (UserPromptSubmit hook; reads hook JSON on stdin)
  operator-inbox.ts open [--root <repository>]
  operator-inbox.ts dispose <hash> --task <id> | --memory <slug> | --answered <reason> [--root <repository>]
  operator-inbox.ts search <words...> [--root <repository>] [--memory <directory>]`;

export type Io = {
  stdin: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

class Failure extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

function fail(message: string, code: number): never {
  throw new Failure(message, code);
}

// The UserPromptSubmit hook: never block, fail or print; the prompt proceeds whatever happens here.
export function captureHook(stdin: () => string, env: NodeJS.ProcessEnv): void {
  try {
    const input = JSON.parse(stdin());
    const root = env.CLAUDE_PROJECT_DIR ?? input.cwd;
    if (
      typeof input.prompt === 'string' &&
      typeof root === 'string' &&
      typeof input.session_id === 'string'
    )
      capture(
        root,
        input.session_id,
        input.prompt,
        env,
        promptOrigin(input.transcript_path, input.prompt_id),
      );
  } catch {
    /* ignored on purpose */
  }
}

function flags(arguments_: string[]) {
  const values = new Map<string, string>();
  const positional: string[] = [];
  const queue = [...arguments_];
  for (let a = queue.shift(); a !== undefined; a = queue.shift()) {
    if (a.startsWith('--')) {
      const value = queue.shift();
      if (value === undefined) fail(usage, 64);
      values.set(a, value);
    } else positional.push(a);
  }
  return { values, positional };
}

async function execute(
  command: string | undefined,
  rest: string[],
  cwd: string,
  write: (text: string) => void,
): Promise<void> {
  const { memoryDirectory } = await import('../harness/memory-directory.ts');
  const { values, positional } = flags(rest);
  const root = resolve(values.get('--root') ?? cwd);

  if (command === 'open') {
    const open = openEntries(root);
    for (const entry of open)
      write(
        `${entry.hash} ${entry.time} ${entry.session.slice(0, 8)} ${oneLine(entry.text, 160)}\n`,
      );
    write(`${open.length} open\n`);
  } else if (command === 'dispose') {
    const prefix = positional[0];
    if (!prefix || !/^[0-9a-f]{4,12}$/u.test(prefix)) fail(usage, 64);
    const matches = [
      ...new Set(
        allEntries(root)
          .map((entry) => entry.hash)
          .filter((hash) => hash.startsWith(prefix)),
      ),
    ];
    if (matches.length !== 1)
      fail(`FAIL ${prefix}: ${matches.length} matching inbox entries`, 1);
    const hash = matches[0] as string;
    const task = values.get('--task');
    const memory = values.get('--memory');
    const answered = values.get('--answered');
    if ([task, memory, answered].filter((v) => v !== undefined).length !== 1)
      fail(usage, 64);
    if (task !== undefined) {
      // The task store reads the pending ref, tasks/ and the archive: a record any of them holds counts.
      let found = false;
      try {
        found = isTaskId(task) && hasTask(root, task);
      } catch (error) {
        if (!(error instanceof TaskDataError)) throw error;
        fail(`FAIL ${task}: ${error.message}`, 1);
      }
      if (!found)
        fail(`FAIL ${task}: no task record; krn task list shows the ids`, 1);
      dispose(root, hash, 'task', task);
    } else if (memory !== undefined) {
      const slug = memory.replace(/\.md$/u, '');
      const directory = values.get('--memory-dir') ?? memoryDirectory(root);
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(slug) ||
        !existsSync(join(directory, `${slug}.md`))
      )
        fail(`FAIL memory:${slug}: no ${join(directory, `${slug}.md`)}`, 1);
      dispose(root, hash, 'memory', slug);
    } else {
      if (!answered?.trim()) fail(usage, 64);
      dispose(root, hash, 'answered', answered.trim());
    }
    write(`disposed ${hash}\n`);
  } else if (command === 'search') {
    const words = positional
      .flatMap((word) => word.toLowerCase().split(/\s+/u))
      .filter((word) => word.length >= 3);
    if (words.length === 0) fail(usage, 64);
    const memory = values.get('--memory') ?? memoryDirectory(root);
    const sources: { path: string; text: string }[] = [];
    const read = (directory: string, extension: string) => {
      try {
        for (const name of readdirSync(directory))
          if (name.endsWith(extension))
            sources.push({
              path: join(directory, name),
              text: readFileSync(join(directory, name), 'utf8').toLowerCase(),
            });
      } catch {
        /* A missing directory has no mentions. */
      }
    };
    read(join(root, 'tasks'), '.json');
    // A record the task store holds only on the pending ref has no file under tasks/.
    for (const [id, contents] of pendingTaskFiles(root))
      sources.push({
        path: `pending tasks/${id}.json`,
        text: contents.toString('utf8').toLowerCase(),
      });
    read(memory, '.md');
    for (const entry of allEntries(root))
      sources.push({
        path: `inbox:${entry.hash}`,
        text: entry.text.toLowerCase(),
      });
    const scored = sources
      .map((source) => ({
        path: source.path,
        score: words.filter((word) => source.text.includes(word)).length,
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 12);
    for (const hit of scored)
      write(`${hit.score}/${words.length} ${hit.path}\n`);
    write(
      scored.length === 0
        ? `no mention of: ${words.join(' ')}\n`
        : `${scored.length} source(s) mention these words; read them before claiming absence\n`,
    );
  } else fail(usage, 64);
}

export async function run(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  io: Io,
): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'capture') {
    captureHook(io.stdin, env);
    return 0;
  }
  try {
    await execute(command, rest, cwd, io.stdout);
    return 0;
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    io.stderr(`${error.message}\n`);
    return error.code;
  }
}
