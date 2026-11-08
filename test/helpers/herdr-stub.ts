import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// Replies captured verbatim from the live Herdr server (test/fixtures/README.md):
// a `*.reply.jsonl` file is what the CLI printed on stdout, a `*.stderr.jsonl`
// file the JSON error it printed on stderr with exit 1.
const fixtures = new URL('../fixtures/herdr/', import.meta.url);

/** What the stub prints for one call and the status it exits with. */
export type Reply = { stdout?: string; stderr?: string; status?: number };

/**
 * Replies keyed "group verb target", else "group verb". A list answers the
 * 1st, 2nd... call whose first words equal its key in turn, its last entry
 * repeating; a call no key matches exits 64.
 */
export type Replies = Readonly<Record<string, Reply | readonly Reply[]>>;

export function capture(name: string): string {
  return readFileSync(new URL(name, fixtures), 'utf8');
}

export function ok(stdout: string): Reply {
  return { stdout };
}

export function failure(stderr: string, status = 1): Reply {
  return { stderr, status };
}

/** A capture printed on the stream its name records. */
export function captureReply(name: string): Reply {
  return name.endsWith('.stderr.jsonl')
    ? failure(capture(name))
    : ok(capture(name));
}

// One shell word: single-quoted, each inner quote closed, escaped, reopened.
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

// Each logged call is one line, each word ended by the unit separator; printf
// without words would still print the separator once.
const logWords = `{ [ $# -eq 0 ] || printf '%s\\037' "$@"; printf '\\n'; }`;

function writeExecutable(path: string, lines: string[]): void {
  writeFileSync(path, [...lines, ''].join('\n'));
  chmodSync(path, 0o755);
}

// A reply runs as a sourced script: it prints both streams byte for byte and
// exits with the reply's status.
function replyScript({ stdout = '', stderr = '', status = 0 }: Reply): string {
  assert.ok(
    Number.isInteger(status) && status >= 0 && status <= 255,
    `herdr stub: status ${status} is not an exit code`,
  );
  return [
    ...(stdout ? [`printf %s ${quote(stdout)}`] : []),
    ...(stderr ? [`printf %s ${quote(stderr)} >&2`] : []),
    `exit ${status}`,
    '',
  ].join('\n');
}

/**
 * Writes `herdr` into `bin`: a stub that runs only shell builtins, so a call
 * costs a shell start instead of a Node start (4 against 57 ms on the lead
 * host). It logs each call, then answers it from `replies`. Its replies and
 * log live in the sibling directory `herdr`; answers the log's path, which
 * exists from the first call.
 */
export function installHerdr(bin: string, replies: Replies): string {
  const state = join(dirname(bin), 'herdr');
  const table = join(state, 'replies');
  for (const [key, entry] of Object.entries(replies)) {
    assert.ok(
      key !== '' && key !== '.' && key !== '..' && !key.includes('/'),
      `herdr stub: key ${JSON.stringify(key)} cannot name a directory`,
    );
    const list = ([] as Reply[]).concat(entry);
    assert.ok(list.length > 0, `herdr stub: key ${key} has no reply`);
    mkdirSync(join(table, key), { recursive: true });
    list.forEach((reply, index) => {
      writeFileSync(join(table, key, String(index)), replyScript(reply));
    });
  }
  const calls = join(state, 'calls');
  writeExecutable(join(bin, 'herdr'), [
    '#!/bin/sh',
    `replies=${quote(table)}`,
    `calls=${quote(calls)}`,
    "us='\x1f'",
    'two=$1${2+ $2}',
    'three=$two${3+ $3}',
    'prefix2=$1$us${2+$2$us}',
    'prefix3=$prefix2${3+$3$us}',
    // A key exists when its first reply does, so no call loops or escapes.
    'if [ -f "$replies/$three/0" ]; then',
    '  key=$three prefix=$prefix3',
    'else',
    '  key=$two prefix=$prefix2',
    'fi',
    'same=0',
    'if [ -f "$calls" ]; then',
    '  while IFS= read -r call; do',
    '    case $call in "$prefix"*) same=$((same + 1)) ;; esac',
    '  done <"$calls"',
    'fi',
    `${logWords} >>"$calls"`,
    '[ -f "$replies/$key/0" ] || exit 64',
    'while [ ! -f "$replies/$key/$same" ]; do same=$((same - 1)); done',
    '. "$replies/$key/$same"',
  ]);
  return calls;
}

/**
 * Writes the agent CLI `name` into `bin`: a builtin-only stub that logs its
 * words to `calls` and exits with `status`.
 */
export function installAgent(
  bin: string,
  name: string,
  calls: string,
  status = 0,
): void {
  writeExecutable(join(bin, name), [
    '#!/bin/sh',
    `${logWords} >>${quote(calls)}`,
    `exit ${status}`,
  ]);
}

/** The logged calls in order, each as its words; none before the first. */
export function readCalls(path: string): string[][] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .slice(0, -1)
    .map((line) => {
      assert.ok(
        line === '' || line.endsWith('\x1f'),
        `a logged word holds a newline: ${JSON.stringify(line)}`,
      );
      return line.split('\x1f').slice(0, -1);
    });
}
