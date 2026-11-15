// The versioned file formats KRN reads and writes. A repository declares the versions it holds once, in
// krn.json under `formats` (`krn.task/v1`); a reader refuses a major this build does not know with exit 78.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every format name with the one major this build reads. */
export const FORMAT_MAJORS: Readonly<Record<string, number>> = {
  'krn.contract': 1,
  'krn.task': 1,
  'krn.record': 1,
  'krn.exposure': 1,
};

export type FormatName = keyof typeof FORMAT_MAJORS;

/** Where each format's JSON Schema lives, relative to the repository root. */
export function schemaPath(name: string, major: number): string {
  return `spec/schema/${name.replace(/^krn\./u, '')}.v${major}.json`;
}

export class FormatError extends Error {
  readonly exitCode = 78;
}

const DECLARATION = /^(krn\.[a-z]+)\/v([1-9][0-9]*)$/u;

/** Refuse a declaration naming a format or a major this build does not read; returns the list unchanged. */
export function checkFormats(declared: readonly string[]): readonly string[] {
  for (const entry of declared) {
    const match = DECLARATION.exec(entry);
    const name = match?.[1];
    const major = Number(match?.[2]);
    const known = name === undefined ? undefined : FORMAT_MAJORS[name];
    if (known === undefined)
      throw new FormatError(
        `krn.json formats: unknown format "${entry}" (this build reads ${supported()})`,
      );
    if (major !== known)
      throw new FormatError(
        `krn.json formats: "${entry}" has major ${major}, this build reads ${name}/v${known}`,
      );
  }
  return declared;
}

function supported(): string {
  return Object.entries(FORMAT_MAJORS)
    .map(([name, major]) => `${name}/v${major}`)
    .join(', ');
}

/** The entry of krn.json `formats` for readers of one store; a repository that declares none is read as v1. */
export function assertFormat(root: string, name: FormatName): void {
  const file = join(root, 'krn.json');
  if (!existsSync(file)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return; // the contract reader reports a malformed krn.json
  }
  const list = (raw as { formats?: unknown } | null)?.formats;
  if (!Array.isArray(list)) return;
  const own = list.filter(
    (entry): entry is string =>
      typeof entry === 'string' && entry.startsWith(`${name}/`),
  );
  checkFormats(own);
}
