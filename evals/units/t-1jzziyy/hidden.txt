import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * That a shot is taken in a world containing the thing it photographs.
 *
 * `chore shots mountain` never took a picture. Not once, in the whole life of the shot: there is no
 * `docs/screenshots/mountain.png` in this repository's history. Every run said the same thing —
 *
 *     missed mountain     nothing to photograph in this world today
 *
 * — because every shot in `shots.cjs` falls back to `world: 'road'` and this one had no world of
 * its own. A road-tree world is not `shaped`, so its high ground is `massifs`, and `planMassifs`
 * puts none on seed 3; `ranges` is null there by construction. Both of the things the shot's search
 * reads are therefore empty in the world it was being taken in.
 *
 * Nothing caught it because a shot that finds nothing is not a failure. `missed` is the honest
 * answer for a world that happens not to have a mountain in it today, so a shot that can *never*
 * find one reads exactly like one that is merely unlucky.
 *
 * Read off the source, because a shot is a browser and a world and is not a thing a unit test can
 * run. What can be held is the pairing, and the pairing is the bug.
 */
describe('the mountain shot', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'shots.cjs'), 'utf8');
  /** The shot's own entry: from its name to the end of its setup. */
  const entry = (): string => {
    const at = source.indexOf("name: 'mountain'");
    expect(at, 'the mountain shot has gone').toBeGreaterThan(0);
    return source.slice(at, source.indexOf("name: 'health'", at));
  };

  it('is taken in the country that has mountains in it', () => {
    /*
     * The endless country is where `ranges` comes from, and `ranges.peaks` is the first thing the
     * shot's search asks for. The road tree answers neither question with anything.
     */
    expect(entry()).toContain("world: 'endless'");
  });

  it('still asks for the peaks that world answers with', () => {
    const body = entry();
    expect(body).toContain('ranges.peaks');
    expect(body, 'and gives up rather than photographing nothing').toContain('if (!peak) return null;');
  });
});

/**
 * And that the run can be given more time than the machine it was written on needed.
 *
 * Playwright's thirty seconds and the hard-coded minute for a world to raise itself are properties
 * of a fast desk rather than of the game. On a small ARM box with no GPU the page takes half a
 * minute to load and the world two and a half more, and every one of those numbers is passed before
 * anything has gone wrong — so the run fails with a timeout that reads like a broken game.
 */
describe('how long a shot is allowed to take', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'shots.cjs'), 'utf8');

  it('is one number, and it can be raised', () => {
    expect(source).toContain("const PATIENCE = Number(process.env.PATIENCE || 0);");
  });

  it('never lowers what was there before', () => {
    // `Math.max(60000, …)` rather than the env outright: an unset or silly PATIENCE cannot make the
    // wait shorter than the minute this always allowed.
    expect(source).toContain("{ timeout: Math.max(60000, PATIENCE) }");
    expect(source, 'and the default leaves playwright its own').toContain('if (PATIENCE) page.setDefaultTimeout(PATIENCE);');
  });
});
