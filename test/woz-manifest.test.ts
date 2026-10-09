import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const acceptedShas: Record<string, string> = {
  'LON-130': '6567b4b78fc5c5b8dae1a8536f42450f5c1c79ce',
  'LON-131': 'fd9b1b56e47f3b630d20ed8588107fd824515ca0',
  'LON-133': 'd1bc745f1872a38f31f25f86311a281b010859a3',
  'LON-20': 'a262a5fb97018c479fb682ccc884bfa03100c591',
  'LON-21': 'c7eaee106ad6695405429373df2f252c82bddd47',
  'LON-22': 'a43a99c77e9b311d508b0072f3dddd7a00445e9a',
};

test('packets do not contain their own accepted change SHA', () => {
  for (const [task, sha] of Object.entries(acceptedShas)) {
    const packet = readFileSync(join(root, 'evals/woz/packets', `${task}.md`), 'utf8');
    assert.equal(
      packet.toLowerCase().includes(sha.slice(0, 7).toLowerCase()),
      false,
      `${task} packet contains its own accepted SHA prefix`,
    );
  }
});
