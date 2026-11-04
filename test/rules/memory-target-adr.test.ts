import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string): Promise<string> =>
  readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('ADR 0014 records the memory target, shadow packets and the GLOBAL v1 store', async () => {
  const adr = await read('docs/adr/0014-operator-decisions-2026-10-23.md');
  assert.match(adr, /^\| D31 \|.*ADR 0002.*memory target.*FR-40/mu);
  assert.match(adr, /^\| D32 \|.*[Ss]hadow packets.*never injected.*D20/mu);
  assert.match(adr, /^\| D33 \|.*GLOBAL `krn memory` v1 store.*frozen/mu);
  assert.match(adr, /decisions D1–D33/u);
  assert.doesNotMatch(adr, /D1–D30/u);
});

test('ADR 0002 is the accepted memory target, not a proposal', async () => {
  const brain = await read('docs/adr/0002-brain-v2.md');
  assert.match(brain, /^Accepted target, unbuilt \(ADR 0014 D31\)/mu);
  assert.doesNotMatch(brain, /remains proposed|Proposed for E3/u);
  assert.doesNotMatch(brain, /^- Implementing the v2 JSON schema/mu);
  assert.doesNotMatch(brain, /gates whether to build the pipeline/u);
  const index = await read('docs/adr/README.md');
  assert.match(
    index,
    /^\| \[0002\]\(0002-brain-v2\.md\) \| accepted target \|/mu,
  );
  assert.match(index, /Operator decisions D1–D33/u);
});
