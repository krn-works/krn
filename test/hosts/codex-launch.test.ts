import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexHost } from '../../src/hosts/codex.ts';

test('CodexHost pins low reasoning effort for bounded shell work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-launch-'));
  try {
    const initialized = spawnSync('git', ['-C', directory, 'init', '-q']);
    assert.equal(initialized.status, 0);
    const argsFile = join(directory, 'args.json');
    const executable = join(directory, 'fake-codex');
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ready' } }) + '\\n');\nprocess.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) + '\\n');\n`,
    );
    await chmod(executable, 0o755);

    const host = new CodexHost({ executable });
    const session = await host.start({
      cwd: directory,
      model: 'gpt-6-luna',
      prompt: 'Run pwd',
      limits: { timeoutMs: 5000 },
    });
    const result = await session.wait();
    const args: string[] = JSON.parse(await readFile(argsFile, 'utf8'));
    assert.ok(
      args.includes('model_reasoning_effort=low'),
      'CodexHost must not inherit a slower user reasoning setting',
    );
    assert.equal(result.finalMessage, 'ready');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
