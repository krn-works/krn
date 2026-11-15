// Runs every task-quality rule over tasks/*.json and exits 1 on any failure. `npm run lint`
// calls it because CI skips the test shards on a pull request that changes only task records.
import { allTaskQualityFailures } from '../src/brain/task-quality.ts';

const failures = allTaskQualityFailures(process.cwd());
for (const failure of failures) console.error(`task-quality: ${failure}`);
console.log(
  failures.length === 0
    ? 'task-quality PASS'
    : `task-quality FAIL ${failures.length}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
