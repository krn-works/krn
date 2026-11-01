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
import { basename, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import * as sandbox from '../../src/verdict/sandbox.ts';

const sandboxUrl = pathToFileURL(
  join(import.meta.dirname, '../../src/verdict/sandbox.ts'),
).href;

test('a failed quarantine of one copy still protects every other copy', async (t) => {
  assert.equal(typeof sandbox.quarantineVerdictTrees, 'function');
  const root = mkdtempSync(join(tmpdir(), 'krn-verdict-quarantine-all-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(process.stderr, 'write', () => true);
  const directory = join(root, 'temporary');
  mkdirSync(directory);
  const owner = join(root, 'owner.mjs');
  // The owner allocates three copies, breaks only the middle record so its quarantine
  // throws, quarantines all three in one call and exits: both neighbours must be marked
  // whichever order the copies are processed in.
  writeFileSync(
    owner,
    [
      `import { writeFileSync } from 'node:fs';`,
      `import { basename, dirname, join } from 'node:path';`,
      `const sandbox = await import(${JSON.stringify(sandboxUrl)});`,
      `const copies = [];`,
      `for (let i = 0; i < 3; i++) copies.push(await sandbox.createWorktreeDirectory(${JSON.stringify(directory)}, ${JSON.stringify(root)}));`,
      `writeFileSync(join(dirname(copies[1]), '.verdict-owners', basename(copies[1]) + '.json'), '{');`,
      `process.stdout.write(JSON.stringify(copies));`,
      `try { sandbox.quarantineVerdictTrees(copies); } catch {}`,
    ].join('\n'),
  );

  const child = spawnSync(process.execPath, [owner], {
    encoding: 'utf8',
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
  });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /verdict quarantine failed/u);
  const [first, , third] = JSON.parse(child.stdout) as string[];
  assert.ok(first && third);
  const quarantined = (copy: string) =>
    JSON.parse(
      readFileSync(
        join(directory, '.verdict-owners', `${basename(copy)}.json`),
        'utf8',
      ),
    ).quarantined;
  assert.equal(quarantined(first), true, 'the copy before the failing one');
  assert.equal(quarantined(third), true, 'the copy after the failing one');

  await sandbox.sweepOrphanedVerdictTrees(root, directory, {
    scopeProbe: () => true,
  });
  assert.ok(existsSync(first), 'a quarantined copy waits for live scopes');
  assert.ok(existsSync(third), 'a quarantined copy waits for live scopes');
});
