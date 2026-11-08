import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Sanctioned stand-in for a host path in a receiver capture. Documented in
// test/fixtures/README.md; the host-path guard
// (test/rules/host-path-guard.test.mjs) accepts it by name.
export const HOST_PATH_PLACEHOLDER = '/work/repo';

const slash = String.fromCharCode(47);
// Same roots the host-path guard forbids in tracked literals.
const hostPath = new RegExp(
  `(?:${[
    `mnt${slash}`,
    `home${slash}krn`,
    `run${slash}user${slash}`,
    `tmp${slash}claude-`,
  ]
    .map((root) => `${slash}${root}`)
    .join('|')})[^\\s"'\\\\]*`,
  'gu',
);

function redact(value: unknown): unknown {
  if (typeof value === 'string')
    return value.replace(hostPath, HOST_PATH_PLACEHOLDER);
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item)]),
    );
  return value;
}

// Python-style separators and ASCII escapes: the captured transcripts keep the
// byte format of the harness that wrote them, so a redacted line stays diffable.
function serialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(serialize).join(', ')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, item]) => `${serialize(key)}: ${serialize(item)}`)
      .join(', ')}}`;
  return JSON.stringify(value).replace(
    /[\u0080-￿]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

// Elide message content, point cwd at the repository, redact host paths.
export function captureFixtureLine(line: string): string {
  const entry: unknown = JSON.parse(line);
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
    return serialize(redact(entry));
  const fields = { ...entry } as Record<string, unknown>;
  const message = fields.message;
  if (
    message !== null &&
    typeof message === 'object' &&
    !Array.isArray(message)
  )
    fields.message = { ...message, content: [] };
  if (typeof fields.cwd === 'string') fields.cwd = '.';
  return serialize(redact(fields));
}

export function captureFixture(transcript: string): string {
  return transcript
    .split('\n')
    .filter((line) => line.trim())
    .map(captureFixtureLine)
    .join('\n')
    .concat('\n');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const source = process.argv[2];
  process.stdout.write(captureFixture(readFileSync(source ?? 0, 'utf8')));
}
