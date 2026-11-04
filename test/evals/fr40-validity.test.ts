import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Dynamic URLs keep an absent base implementation an assertion failure.
const dir = fileURLToPath(new URL('../../evals/fr40/', import.meta.url));
const power = await import(
  new URL('../../evals/fr40/power.ts', import.meta.url).href
).catch(() => undefined);
const validity = await readFile(join(dir, 'validity.json'), 'utf8')
  .then((text) => JSON.parse(text))
  .catch(() => undefined);

test('FR-40 validity record exists with its power module', () => {
  assert.equal(
    typeof validity,
    'object',
    'evals/fr40/validity.json is missing',
  );
  assert.equal(
    typeof power?.goPower,
    'function',
    'evals/fr40/power.ts goPower is missing',
  );
});

test('recorded power and KILL figures match the exact computation', () => {
  assert.equal(typeof power?.goPower, 'function');
  const { effect, alpha, target, killBound, killZ, discordance } =
    validity.design;
  for (const scenario of validity.scenarios) {
    assert.deepEqual(
      scenario.goPower,
      discordance.map((d: number) =>
        power.round3(power.goPower(scenario.units, d, effect, alpha)),
      ),
      `${scenario.name} goPower`,
    );
    assert.deepEqual(
      scenario.killUnderNull,
      discordance.map((d: number) =>
        power.round3(
          power.killProbability(scenario.units, d, killBound, killZ),
        ),
      ),
      `${scenario.name} killUnderNull`,
    );
    assert.equal(
      scenario.goMinimumWins,
      power.goMinimumWins(scenario.units, alpha),
      `${scenario.name} goMinimumWins`,
    );
  }
  assert.deepEqual(
    validity.unitsForTargetPower,
    discordance.map((d: number) =>
      power.unitsForPower(d, effect, alpha, target, 400),
    ),
  );
});

test('inventory counts and clusters agree with each other', () => {
  const inv = validity.inventory;
  assert.equal(
    inv.usable + inv.needsCheck + inv.unusable,
    inv.defectsAfterDedup,
  );
  const tasks = inv.usableClusters.reduce(
    (sum: number, c: { tasks: number }) => sum + c.tasks,
    0,
  );
  assert.equal(tasks, inv.usable);
  const units = validity.scenarios.map((s: { units: number }) => s.units);
  assert.deepEqual(units, [
    inv.usableClusters.length,
    inv.usable,
    inv.usable + inv.needsCheck,
  ]);
});

test('verdict follows the 0.8 power rule', () => {
  const best = Math.max(
    ...validity.scenarios.flatMap((s: { goPower: number[] }) => s.goPower),
  );
  assert.equal(
    validity.verdict,
    best < validity.design.target ? 'below-power' : 'powered',
  );
});

test('no other FR-40 file cites an exemplar base or fix commit', async () => {
  const shas: string[] = validity.inventory.usableClusters.flatMap(
    (c: { base: string; fix: string }) => [c.base, c.fix],
  );
  const files: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(dir);
  for (const file of files) {
    if (file === join(dir, 'validity.json')) continue;
    const text = (await readFile(file, 'utf8')).toLowerCase();
    for (const sha of shas)
      assert.ok(
        !text.includes(sha.slice(0, 7)),
        `${relative(dir, file)} cites ${sha}`,
      );
  }
});
