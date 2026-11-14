import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: runs the real `krn findings validate` entry on hand-written files.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function validate(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'krn-findings-'));
  const file = join(dir, 'findings.json');
  writeFileSync(file, content);
  return spawnSync(process.execPath, [cli, 'findings', 'validate', file], {
    encoding: 'utf8',
  });
}

const confirmed = {
  id: 'f1',
  title: 'off by one',
  status: 'confirmed',
  severity: 'high',
  evidence: ['src/a.ts:12'],
  reproduce: 'node --test test/a.test.ts',
  foundBy: 'finder',
  verifiedBy: 'verifier',
};

test('a valid file passes', () => {
  const result = validate(
    JSON.stringify({
      findings: [
        confirmed,
        { id: 'f2', title: 'maybe', status: 'needs_validation' },
        { id: 'f3', title: 'no', status: 'rejected' },
      ],
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PASS 3 finding/u);
});

test('an empty findings list passes', () => {
  assert.equal(validate('{"findings":[]}').status, 0);
});

test('confirmed without evidence fails', () => {
  const { evidence: _evidence, ...bare } = confirmed;
  const result = validate(JSON.stringify({ findings: [bare] }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /f1: confirmed needs evidence/u);
});

test('confirmed with evidence lacking a line fails', () => {
  const result = validate(
    JSON.stringify({ findings: [{ ...confirmed, evidence: ['src/a.ts'] }] }),
  );
  assert.equal(result.status, 1);
});

test('confirmed without a reproducing command fails', () => {
  const result = validate(
    JSON.stringify({ findings: [{ ...confirmed, reproduce: ' ' }] }),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reproduce/u);
});

test('the finder cannot verify its own finding', () => {
  const result = validate(
    JSON.stringify({ findings: [{ ...confirmed, verifiedBy: 'finder' }] }),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not the finder/u);
});

test('severity on needs_validation fails', () => {
  const result = validate(
    JSON.stringify({
      findings: [
        {
          id: 'f2',
          title: 'maybe',
          status: 'needs_validation',
          severity: 'low',
        },
      ],
    }),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs_validation must not carry a severity/u);
});

test('an unknown status, malformed JSON and a missing file exit distinctly', () => {
  assert.equal(
    validate('{"findings":[{"id":"x","title":"t","status":"sure"}]}').status,
    1,
  );
  assert.equal(validate('{').status, 65);
  const missing = spawnSync(
    process.execPath,
    [cli, 'findings', 'validate', '/nonexistent/f.json'],
    { encoding: 'utf8' },
  );
  assert.equal(missing.status, 66);
});
