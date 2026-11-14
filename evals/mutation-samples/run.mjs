// Applies each hand mutation to its module, runs the module's own test file, and prints
// whether the tests killed it (a red run) or it survived. Restores every file afterwards.
// Usage: node evals/mutation-samples/run.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

const modules = [
  {
    file: 'src/ci/ship.ts',
    test: 'test/ci/ship.test.ts',
    mutants: [
      [
        'instruction-bytes failure no longer refuses',
        'rule.code !== 0',
        'rule.code === 0',
      ],
      ['push failure exit code 70 becomes 71', 'exitCode: 70', 'exitCode: 71'],
      [
        'still-open exits 81 instead of 80',
        'verdict: open\\b/mu, 80',
        'verdict: open\\b/mu, 81',
      ],
      [
        'closed-unmerged exits 78 instead of 79',
        'closed unmerged\\b/mu, 79',
        'closed unmerged\\b/mu, 78',
      ],
      [
        'a real fetch failure is retried as a lock',
        '!gitLockError.test(fetched.stderr)',
        'gitLockError.test(fetched.stderr)',
      ],
    ],
  },
  {
    file: 'src/hook/stop.ts',
    test: 'test/hook/stop.test.ts',
    mutants: [
      [
        'a branch with no commit passes',
        'Number(ahead.trim()) === 0',
        'Number(ahead.trim()) === 99',
      ],
      ['a missing runner (126) is not refused', 'exit 12[67]$', 'exit 12[7]$'],
      [
        'pre-existing failures count as fresh',
        'if (fresh.length === 0)',
        'if (fresh.length !== 0)',
      ],
      [
        'a green run is treated as failing',
        'if (failing.length === 0) return',
        'if (failing.length === 1) return',
      ],
      [
        'the verdict exit code is inverted',
        'outcome.ok ? 0 : 1',
        'outcome.ok ? 1 : 0',
      ],
    ],
  },
  {
    file: 'src/cli/lane-run.ts',
    test: 'test/cli/lane-run.test.ts',
    mutants: [
      [
        'the session timeout may exceed the token life',
        'Math.min(wanted, defaultSessionTimeoutMs)',
        'Math.max(wanted, defaultSessionTimeoutMs)',
      ],
      [
        'a failed token mint reads as success',
        'if (result.status === 0) return undefined;',
        'if (result.status !== 0) return undefined;',
      ],
      [
        'a lane with no commit goes on to ship',
        "commits.length === 0) return await stop('no commit')",
        "commits.length === 99) return await stop('no commit')",
      ],
      [
        'an open task no longer stops the ship',
        "getTask(started.path, task).status !== 'closed'",
        "getTask(started.path, task).status === 'closed'",
      ],
      [
        'a merged ship exits as not delivered',
        'exitCode: merged ? 0 : exitNoDelivery',
        'exitCode: merged ? exitNoDelivery : 0',
      ],
    ],
  },
];

const rows = [];
for (const { file, test, mutants } of modules) {
  const path = `${root}${file}`;
  const original = readFileSync(path, 'utf8');
  try {
    for (const [name, from, to] of mutants) {
      if (original.split(from).length !== 2)
        throw new Error(`${file}: "${from}" must occur exactly once`);
      writeFileSync(
        path,
        original.replace(from, () => to),
      );
      const run = spawnSync('node', ['--test', test], {
        cwd: root,
        encoding: 'utf8',
      });
      rows.push({ file, name, killed: run.status !== 0 });
    }
  } finally {
    writeFileSync(path, original);
  }
}
for (const row of rows)
  console.log(
    `${row.killed ? 'killed  ' : 'SURVIVED'} ${row.file} :: ${row.name}`,
  );
for (const file of new Set(rows.map((row) => row.file))) {
  const own = rows.filter((row) => row.file === file);
  const killed = own.filter((row) => row.killed).length;
  console.log(`${file}: ${killed}/${own.length} killed`);
}
