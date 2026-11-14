import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

interface Surface {
  path: string;
  must: string;
  forbid?: string;
}
interface Fact {
  id: string;
  statement: string;
  surfaces: Surface[];
}
const { facts } = JSON.parse(read('spec/steering-facts.json')) as {
  facts: Fact[];
};

for (const fact of facts) {
  test(`steering fact ${fact.id}: ${fact.statement}`, () => {
    assert.ok(fact.surfaces.length > 0);
    for (const surface of fact.surfaces) {
      const text = read(surface.path);
      assert.ok(
        text.includes(surface.must),
        `${surface.path} must say: ${surface.must}`,
      );
      if (surface.forbid !== undefined) {
        assert.ok(
          !text.includes(surface.forbid),
          `${surface.path} contradicts: ${surface.forbid}`,
        );
      }
    }
  });
}
