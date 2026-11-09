import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Tracked agent config must never carry credentials. Findings name the file
// and key (or line) only; a matched value is never printed.
const AGENT_CONFIG = /^(\.claude\/|\.codex\/|\.mcp\.json$)/u;
const TOKEN_SHAPES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/u,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/u,
  /gh[po]_[A-Za-z0-9]{20,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /xox[bp]-[A-Za-z0-9-]{10,}/u,
  /AKIA[0-9A-Z]{16}/u,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/u,
];
const SECRET_KEY = /TOKEN|SECRET|KEY|PASSWORD/iu;
const KEY_VALUE = /^\s*"?([A-Za-z0-9_.-]+)"?\s*[:=]\s*"([^"\n]*)"/u;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values())
    bits -= (n / value.length) * Math.log2(n / value.length);
  return bits;
}

function looksSecret(value: string): boolean {
  if (value.length < 16 || value.includes('${') || /\s/u.test(value))
    return false;
  if (/^[~./]|^\d+$|^https?:\/\//u.test(value)) return false;
  return entropy(value) >= 3.5;
}

function scanAgentConfig(file: string, text: string): string[] {
  const findings: string[] = [];
  text.split('\n').forEach((line, index) => {
    const pair = KEY_VALUE.exec(line);
    const key = pair?.[1];
    const value = pair?.[2];
    if (
      key !== undefined &&
      value !== undefined &&
      SECRET_KEY.test(key) &&
      looksSecret(value)
    ) {
      findings.push(`${file}: key ${key} holds a token-shaped value`);
    } else if (TOKEN_SHAPES.some((shape) => shape.test(line))) {
      const where = key === undefined ? `line ${index + 1}` : `key ${key}`;
      findings.push(`${file}: ${where} matches a token pattern`);
    }
  });
  return findings;
}

test('tracked agent config holds no token-shaped values', () => {
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => AGENT_CONFIG.test(file))
    .filter((file) => lstatSync(join(root, file)).isFile());
  assert.ok(
    files.includes('.claude/settings.json'),
    'settings.json must be scanned',
  );
  const findings = files.flatMap((file) =>
    scanAgentConfig(file, readFileSync(join(root, file), 'utf8')),
  );
  assert.deepEqual(findings, []);
});

test('a fake token fails by file and key without printing the value', () => {
  const fake = `${['sk', 'ant', 'api03'].join('-')}-${'Zq9'.repeat(10)}`;
  const json = JSON.stringify({ env: { ANTHROPIC_API_KEY: fake } }, null, 2);
  const findings = scanAgentConfig('.claude/settings.json', json);
  assert.equal(findings.length, 1);
  assert.match(
    findings[0] ?? '',
    /^\.claude\/settings\.json: key ANTHROPIC_API_KEY /u,
  );
  assert.ok(!(findings[0] ?? '').includes(fake));
  const generic = ['q8Zr', 'Tt4L', 'p0Xv', 'N2mB', 'c7Yd'].join('');
  assert.equal(
    scanAgentConfig('x.toml', `DB_PASSWORD = "${generic}"`).length,
    1,
  );
  for (const ok of [
    '${API_KEY}',
    '',
    '12345678901234567890',
    '/home/me/key.pem',
  ]) {
    assert.deepEqual(scanAgentConfig('x.json', `"API_KEY": "${ok}"`), []);
  }
  assert.equal(
    scanAgentConfig('x', `h = "Bearer ${'a1B2'.repeat(6)}"`).length,
    1,
  );
});
