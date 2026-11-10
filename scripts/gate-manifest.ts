// The gate manifest: node scripts/gate-manifest.ts [--range A..B | --last N] [--json]
import { resolve } from 'node:path';
import {
  countTouches,
  gateManifest,
  gitLog,
  renderManifest,
  touches,
} from '../src/outcome/gate-manifest.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const last = flag('--last') ?? '100';
if (!/^[1-9]\d*$/u.test(last)) {
  process.stderr.write('gate-manifest: --last needs a positive integer\n');
  process.exit(64);
}
const range = flag('--range') ?? `HEAD~${last}..HEAD`;
const root = resolve(import.meta.dirname, '..');
const manifest = gateManifest(root);
const touched = touches(gitLog(root, range), manifest);
process.stdout.write(
  args.includes('--json')
    ? `${JSON.stringify({ range, manifest, counts: countTouches(touched), touched })}\n`
    : renderManifest(manifest, touched),
);
