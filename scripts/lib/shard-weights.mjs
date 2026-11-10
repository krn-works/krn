// Loads the CI-measured median wall time, in seconds, of each test file from
// shard-weights.json (written by scripts/shard-weights-refresh.mjs). The
// weights are data read at run time, never imported, so refreshing them does
// not edit a module the suite executes. A missing or malformed file yields no
// weights and the planner falls back to file sizes.
import { readFileSync } from 'node:fs';

export const SHARD_WEIGHTS_PATH = new URL(
  './shard-weights.json',
  import.meta.url,
);

export function parseShardWeights(text) {
  try {
    const weights = JSON.parse(text)?.weights;
    if (typeof weights !== 'object' || weights === null) return {};
    return Object.freeze(
      Object.fromEntries(
        Object.entries(weights).filter(
          ([file, seconds]) =>
            typeof file === 'string' &&
            typeof seconds === 'number' &&
            Number.isFinite(seconds) &&
            seconds >= 0,
        ),
      ),
    );
  } catch {
    return {};
  }
}

export function loadShardWeights(path = SHARD_WEIGHTS_PATH) {
  try {
    return parseShardWeights(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export const TEST_FILE_WEIGHTS = loadShardWeights();
