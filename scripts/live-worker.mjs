import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

if (process.env.KRN_LIVE !== '1') {
  console.error('live:worker requires KRN_LIVE=1');
  process.exit(64);
}
const parent = resolve('.krn/runs');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'worker-live-'));
const repo = join(root, 'repo');
const run = join(repo, '.krn', 'worker');
mkdirSync(join(repo, 'spec'), { recursive: true });
copyFileSync('spec/worker-scope.json', join(repo, 'spec/worker-scope.json'));
writeFileSync(join(repo, 'a.txt'), 'alpha\n');
function execute(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}`);
}
for (const args of [
  ['init', '-q'],
  ['add', '.'],
  [
    '-c',
    'user.name=worker',
    '-c',
    'user.email=worker@example.invalid',
    'commit',
    '-qm',
    'base',
  ],
])
  execute('git', ['-C', repo, ...args]);
const cli = resolve('src/cli/krn.mjs');
const brief = join(root, 'brief.md');
const message = join(root, 'message.md');
writeFileSync(
  brief,
  'Read a.txt. Return a complete worker report with its content in summary. Do not change files.',
);
writeFileSync(
  message,
  'Without tools, return a complete worker report with the word count of that file in summary.',
);
try {
  const worker = (...args) =>
    execute(process.execPath, [cli, 'worker', ...args, '--run', run]);
  worker('start', '--repo', repo, '--brief', brief);
  // A live compaction must finish before the fix turn starts.
  worker('send', '--message', message, '--compact', 'always');
  const metrics = JSON.parse(
    readFileSync(join(run, 'rounds', '002', 'metrics.json'), 'utf8'),
  );
  if (metrics.compacted !== true)
    throw new Error('live worker round 2 did not compact');
} finally {
  execute(process.execPath, [cli, 'worker', 'stop', '--run', run]);
}
console.log(`live worker evidence: ${root}`);
