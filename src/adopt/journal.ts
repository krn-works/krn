// A write journal for adoption: each path is noted before its first write so a failed run can restore it.
import {
  appendFileSync as appendFile,
  existsSync,
  lstatSync,
  mkdirSync as makeDirectory,
  symlinkSync as makeLink,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync as writeFile,
} from 'node:fs';
import { dirname } from 'node:path';

type Before =
  | { kind: 'absent' }
  | { kind: 'file'; content: Buffer }
  | { kind: 'link'; target: string };

export class Journal {
  private readonly before = new Map<string, Before>();

  /** Notes the state of `path` (and its topmost missing ancestor) before it changes. */
  note(path: string): void {
    let top = path;
    while (!existsSyncOrLink(top)) {
      this.record(top, { kind: 'absent' });
      top = dirname(top);
      if (top === dirname(top)) return;
    }
    if (top !== path) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      this.record(path, { kind: 'link', target: readlinkSync(path) });
    else if (stat.isFile())
      this.record(path, { kind: 'file', content: readFileSync(path) });
  }

  /** Paths noted as absent before this run wrote them. */
  absentPaths(): string[] {
    return [...this.before]
      .filter(([, state]) => state.kind === 'absent')
      .map(([path]) => path);
  }

  private record(path: string, state: Before): void {
    if (!this.before.has(path)) this.before.set(path, state);
  }

  /** Restores every noted path: new paths are removed, changed files get their old content back. */
  rollback(): void {
    for (const [path, state] of [...this.before].reverse()) {
      rmSync(path, { recursive: true, force: true });
      if (state.kind === 'file') {
        makeDirectory(dirname(path), { recursive: true });
        writeFile(path, state.content);
      } else if (state.kind === 'link') makeLink(state.target, path);
    }
    this.before.clear();
  }
}

function existsSyncOrLink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return existsSync(path);
  }
}

let active: Journal | undefined;

/** Runs `run` with `journal` noting every write made through this module. */
export function recording<T>(journal: Journal, run: () => T): T {
  const previous = active;
  active = journal;
  try {
    return run();
  } finally {
    active = previous;
  }
}

export function noteWrite(path: string): void {
  active?.note(path);
}

export function writeFileSync(path: string, data: string): void {
  noteWrite(path);
  writeFile(path, data);
}

export function appendFileSync(path: string, data: string): void {
  noteWrite(path);
  appendFile(path, data);
}

export function symlinkSync(target: string, path: string): void {
  noteWrite(path);
  makeLink(target, path);
}

export function mkdirSync(path: string): void {
  noteWrite(path);
  makeDirectory(path, { recursive: true });
}
