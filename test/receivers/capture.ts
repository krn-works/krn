import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

type Stream = { readonly file: string; readonly sha256: string };
type Capture = {
  readonly name: string;
  readonly exitCode: number;
  readonly stdout?: Stream;
  readonly stderr?: Stream;
  readonly output?: Stream;
};

/** One capture's bytes per stream, failing when a file drifts from provenance.json. */
export function capture(
  directory: string,
  name: string,
): { exitCode: number; streams: Record<string, Buffer> } {
  const base = new URL(`../${directory}/`, import.meta.url);
  const provenance = JSON.parse(
    readFileSync(new URL('provenance.json', base), 'utf8'),
  ) as { captures: Capture[] };
  const entry: Capture | undefined = provenance.captures.find(
    (item) => item.name === name,
  );
  assert.ok(entry, `${directory}/provenance.json lists ${name}`);
  const streams: Record<string, Buffer> = {};
  for (const key of ['stdout', 'stderr', 'output'] as const) {
    const stream: Stream | undefined = entry[key];
    if (!stream) continue;
    const bytes: Buffer = readFileSync(new URL(stream.file, base));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      stream.sha256,
      `${directory}/${stream.file} is unchanged since capture`,
    );
    streams[key] = bytes;
  }
  return { exitCode: entry.exitCode, streams };
}
