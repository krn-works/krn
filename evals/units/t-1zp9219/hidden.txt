import { afterEach, describe, expect, it } from 'vitest';
import config from '../vite.config';

/**
 * How long a test is allowed to take, and why it can be lengthened from outside — #362.
 *
 * `testTimeout` is a budget for *work*, and the work is not the same size on every machine. Growing
 * a patch of the endless country is *"about six hundred milliseconds"* on the desk
 * `country.worker.ts` was written for, and **fourteen seconds** on a four-core ARM box — measured
 * over two hundred seeds through `growPatch`, 2794.9s for the lot. So a test that grows a handful of
 * patches is budgeted at two minutes against work that takes twenty times what the budget assumed.
 *
 * It does not fail. It runs out of clock, which looks exactly like failing: 125s welcoming a player
 * to a world, 285s clearing what was growing inside a paddock's rails, on a tree CI had already
 * passed green. `vite.config.ts` says the same thing about starvation one paragraph down —
 * *"a starved measurement does not look starved, it looks broken."*
 *
 * And it cost a release, which is what makes it worth a test rather than a comment. `chore release`
 * runs the whole suite as its first act, on the honest argument that a release is the wrong place to
 * find out — so a machine that cannot finish the suite cannot ship, however green CI is on the very
 * same commit.
 */

/** The config as vitest actually asks for it: a function of the command it was invoked with. */
const made = () => (config as unknown as (env: { command: string; mode: string }) =>
  { test: { testTimeout: number } })({ command: 'serve', mode: 'test' });

const DEFAULT = 120_000;

afterEach(() => { delete process.env.TEST_TIMEOUT; });

describe('how long a test is allowed to take', () => {
  it('is two minutes for anybody who has not asked for longer', () => {
    expect(made().test.testTimeout).toBe(DEFAULT);
  });

  it('is longer on a machine slow enough to need it', () => {
    process.env.TEST_TIMEOUT = '600000';
    expect(made().test.testTimeout).toBe(600_000);
  });

  /*
   * Only ever longer. The same rule `PATIENCE` follows in `shots.cjs`, and for the same reason: a
   * knob that can shorten the clock is a knob that can make the suite fail for a reason nobody
   * typed on purpose — and a mistyped one would otherwise be read as nought and time out instantly.
   */
  it('never shortens it, whatever it is handed', () => {
    for (const asked of ['1000', '0', '-5', 'oops', '', 'Infinity']) {
      process.env.TEST_TIMEOUT = asked;
      expect(made().test.testTimeout, `TEST_TIMEOUT=${asked}`).toBeGreaterThanOrEqual(DEFAULT);
    }
  });

  it('reads a word as no answer rather than as no time at all', () => {
    process.env.TEST_TIMEOUT = 'oops';
    expect(made().test.testTimeout).toBe(DEFAULT);
  });
});
