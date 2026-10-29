import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/context-precompact.ts', import.meta.url),
);

test('precompact captures receiver streams and exit code without failing the hook', () => {
  assert.ok(existsSync(script), 'precompact script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-precompact-'));
  try {
    mkdirSync(join(root, 'src/cli'), { recursive: true });
    writeFileSync(
      join(root, 'src/cli/main.ts'),
      "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write('receiver stderr'); process.exitCode = 7;\n",
    );
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: 'unused',
        hook_event_name: 'PreCompact',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    const capture = readFileSync(
      join(root, '.krn/runs/claude/context-gauge/session/precompact.txt'),
      'utf8',
    );
    assert.ok(
      capture.includes(JSON.stringify(['state', 'check', '--root', root])),
    );
    assert.match(capture, /receiver stderr/u);
    assert.match(capture, /exit code: 7/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
