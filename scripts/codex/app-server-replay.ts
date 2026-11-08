#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Readable } from 'node:stream';

// Stands in for `codex app-server --listen stdio://` at the stdio pipe
// (KRN_CODEX_BIN), so the CLI, driver and CodexAppServer above it stay real.
// A transcript holds one JSON-RPC frame per line: `> ` and what KRN wrote,
// `< ` and what Codex wrote, byte for byte except host roots (the working
// directory, home, Codex home and runtime directory), which become the KRN-12
// capture placeholder (test/fixtures/README.md).
//   record: CODEX_KRN_TARGET=<codex> runs the real app-server in between and
//           appends every frame to CODEX_KRN_LOG.
//   replay: CODEX_KRN_REPLAY=<transcript> expects each `>` frame in order,
//           answers with the `<` frames after it, appends what crossed the
//           pipe to CODEX_KRN_LOG and exits 1 at the first mismatch.

const placeholder = '/work/repo';

type Frame = { readonly outbound: boolean; readonly text: string };

function redact(line: string, roots: readonly string[]): string {
  let text = line;
  for (const root of [...roots].sort((a, b) => b.length - a.length))
    if (root.length > 1 && root.startsWith('/'))
      text = text.replaceAll(root, placeholder);
  return text;
}

/** Plays a recorded transcript against the outbound lines KRN writes. */
export class ReplayTransport {
  readonly #frames: readonly Frame[];
  readonly #roots: readonly string[];
  readonly #send: (lines: string) => void;
  readonly #log: (lines: string) => void;
  #cursor = 0;

  constructor(
    transcript: string,
    roots: readonly string[],
    send: (lines: string) => void,
    log: (lines: string) => void,
  ) {
    if (!transcript.endsWith('\n'))
      throw new Error('replay transcript must end with a newline');
    this.#frames = transcript
      .slice(0, -1)
      .split('\n')
      .map((line, index) => {
        const outbound = line.startsWith('> ');
        if (!outbound && !line.startsWith('< '))
          throw new Error(
            `replay transcript line ${index + 1} needs a "> " or "< " prefix`,
          );
        return { outbound, text: line.slice(2) };
      });
    this.#roots = roots;
    this.#send = send;
    this.#log = log;
  }

  /** Sends the inbound frames that come before the first outbound frame. */
  start(): void {
    this.#answer();
  }

  /** Takes one outbound line; false when it is not the next expected frame. */
  receive(line: string): boolean {
    const text = redact(line, this.#roots);
    this.#log(`> ${text}\n`);
    const frame = this.#frames[this.#cursor];
    if (!frame?.outbound || frame.text !== text) return false;
    this.#cursor += 1;
    this.#answer();
    return true;
  }

  get complete(): boolean {
    return this.#cursor === this.#frames.length;
  }

  #answer(): void {
    let lines = '';
    let logged = '';
    for (
      let frame = this.#frames[this.#cursor];
      frame && !frame.outbound;
      frame = this.#frames[this.#cursor]
    ) {
      lines += `${frame.text}\n`;
      logged += `< ${frame.text}\n`;
      this.#cursor += 1;
    }
    if (!lines) return;
    // Log first: once KRN reads the last answer it may kill this process.
    this.#log(logged);
    this.#send(lines);
  }
}

function eachLine(
  stream: Readable,
  take: (line: string) => void,
  end: () => void,
): void {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    rest += chunk;
    for (let at = rest.indexOf('\n'); at >= 0; at = rest.indexOf('\n')) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      take(line);
    }
  });
  stream.on('end', end);
}

/** MCP server names the recorded thread/start turned off, in order. */
export function recordedServers(transcript: string): { name: string }[] {
  for (const line of transcript.split('\n')) {
    if (!line.startsWith('> ')) continue;
    const frame = JSON.parse(line.slice(2));
    if (frame.method !== 'thread/start') continue;
    return Object.keys(frame.params?.config ?? {}).flatMap((key) => {
      const name = key.match(/^mcp_servers\.(.+)\.enabled$/)?.[1];
      return name ? [{ name }] : [];
    });
  }
  return [];
}

// `mcp list --json` runs before thread/start, outside the pipe: replay
// answers with the names its transcript turned off, record asks the target
// and keeps only the names (the full list carries host commands and env).
function mcpList(replay: string | undefined, target: string | undefined) {
  if (replay) {
    process.stdout.write(
      `${JSON.stringify(recordedServers(readFileSync(replay, 'utf8')))}\n`,
    );
    return 0;
  }
  const listed = spawnSync(target ?? '', ['mcp', 'list', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (listed.status !== 0) return listed.status ?? 1;
  const names = (JSON.parse(listed.stdout) as { name: string }[]).map(
    ({ name }) => ({ name }),
  );
  process.stdout.write(`${JSON.stringify(names)}\n`);
  return 0;
}

function main(): void {
  const log = process.env.CODEX_KRN_LOG;
  const replay = process.env.CODEX_KRN_REPLAY;
  const target = process.env.CODEX_KRN_TARGET;
  const args = process.argv.slice(2);
  if (log && !replay !== !target && args.join(' ') === 'mcp list --json')
    process.exit(mcpList(replay, target));
  if (
    !log ||
    !replay === !target ||
    args.join(' ') !== 'app-server --listen stdio://'
  ) {
    process.stderr.write(
      'app-server-replay: run as `app-server --listen stdio://` with CODEX_KRN_LOG and one of CODEX_KRN_REPLAY or CODEX_KRN_TARGET\n',
    );
    process.exit(64);
  }
  const roots = [
    process.cwd(),
    homedir(),
    process.env.CODEX_HOME ?? '',
    process.env.XDG_RUNTIME_DIR ?? '',
  ];
  const append = (text: string) => appendFileSync(log, text);
  if (replay) {
    const transport = new ReplayTransport(
      readFileSync(replay, 'utf8'),
      roots,
      (lines) => process.stdout.write(lines),
      append,
    );
    transport.start();
    eachLine(
      process.stdin,
      (line) => {
        if (!transport.receive(line)) process.exit(1);
      },
      () => process.exit(transport.complete ? 0 : 1),
    );
    return;
  }
  const child = spawn(target ?? '', args, {
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('CODEX_KRN_'),
      ),
    ),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  child.on('error', (error) => {
    process.stderr.write(`app-server-replay: ${error.message}\n`);
    process.exit(127);
  });
  child.on('close', (code) => process.exit(code ?? 1));
  child.stdin.on('error', () => undefined);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(signal, () => child.kill(signal));
  eachLine(
    process.stdin,
    (line) => {
      append(`> ${redact(line, roots)}\n`);
      child.stdin.write(`${line}\n`);
    },
    () => child.stdin.end(),
  );
  eachLine(
    child.stdout,
    (line) => {
      append(`< ${redact(line, roots)}\n`);
      process.stdout.write(`${line}\n`);
    },
    () => undefined,
  );
}

if (import.meta.main) main();
