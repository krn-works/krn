// Exits 0 when the named check is one CI still runs (see scripts/lib/ci-checks.ts), 1 when it is not.
import { listCiChecks } from './lib/ci-checks.ts';

const check = process.argv[2];
if (check === undefined || process.argv.length !== 3) {
  process.stderr.write('usage: node scripts/ci-check-wired.ts <check>\n');
  process.exit(64);
}
if (!listCiChecks(process.cwd()).includes(check)) {
  process.stderr.write(`not a check CI runs: ${check}\n`);
  process.exit(1);
}
process.stdout.write(`wired: ${check}\n`);
