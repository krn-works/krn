import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ledgerCommand } from '../../src/cli/ledger.ts';
import { CliUsageError } from '../../src/cli-kit/usage-error.ts';

test('--window takes full ISO timestamps, not only dates, and refuses anything else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-cli-'));
  const path = process.env.PATH;
  const write = process.stdout.write;
  try {
    await mkdir(join(dir, 'bin'));
    // A stand-in `gh` that lists no PRs, so the window runs without network.
    await writeFile(join(dir, 'bin/gh'), '#!/bin/sh\necho "[]"\n');
    await chmod(join(dir, 'bin/gh'), 0o755);
    process.env.PATH = `${join(dir, 'bin')}:${path}`;
    let out = '';
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    await ledgerCommand([
      '--window',
      '2026-11-10T08:15:30.000Z',
      '2026-11-11T17:45:00Z',
      '--json',
      '--root',
      dir,
      '--transcripts',
      dir,
      '--repo',
      'o/r',
    ]);
    process.stdout.write = write;
    const report = JSON.parse(out) as { window: { from: string; to: string } };
    assert.equal(report.window.from, '2026-11-10T08:15:30Z');
    assert.equal(report.window.to, '2026-11-11T17:45:00Z');
    await assert.rejects(
      ledgerCommand(['--window', '2026-11-10T08:15:30Z', 'later']),
      CliUsageError,
    );
  } finally {
    process.stdout.write = write;
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  }
});

test('--advisor-trial flags a thin win by default and --min-units moves the threshold', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-cli-'));
  const path = process.env.PATH;
  const write = process.stdout.write;
  try {
    await mkdir(join(dir, 'bin'));
    // A stand-in `gh` replaying the shapes of the merged-PR list, commit list, branch and Check replies.
    await writeFile(
      join(dir, 'bin/gh'),
      `#!/bin/sh
case "$*" in
  *"pr list"*) printf '%s\\n' '[{"number":1,"body":"Lane: krn lane brief\\nAdvisor arm: fable\\n"},{"number":2,"body":"Lane: krn lane brief\\nAdvisor arm: none\\n"}]' ;;
  *"pr view 1"*headRefName*) printf '%s\\n' '{"createdAt":"2026-11-01T00:00:00Z","headRefName":"b1"}' ;;
  *"pr view 2"*headRefName*) printf '%s\\n' '{"createdAt":"2026-11-01T00:00:00Z","headRefName":"b2"}' ;;
  *"pr view 1"*) printf '%s\\n' '["1111111111111111111111111111111111111111"]' ;;
  *"pr view 2"*) printf '%s\\n' '["2222222222222222222222222222222222222222"]' ;;
  *"run list"*) echo '[]' ;;
  *1111111111111111111111111111111111111111*) printf '%s\\n' '[{"name":"Check","status":"completed","conclusion":"success","started_at":"2026-11-01T08:00:00Z"}]' ;;
  *) printf '%s\\n' '[{"name":"Check","status":"completed","conclusion":"failure","started_at":"2026-11-01T08:00:00Z"}]' ;;
esac
`,
    );
    await chmod(join(dir, 'bin/gh'), 0o755);
    process.env.PATH = `${join(dir, 'bin')}:${path}`;
    const trial = async (...extra: string[]) => {
      let out = '';
      process.stdout.write = ((chunk: string) => {
        out += chunk;
        return true;
      }) as typeof process.stdout.write;
      try {
        await ledgerCommand(['--advisor-trial', '--repo', 'o/r', ...extra]);
      } finally {
        process.stdout.write = write;
      }
      return out;
    };
    assert.match(
      await trial(),
      /^thin win: advisor leads .*only 1 measured units \(fewer than 5\)$/m,
    );
    assert.match(
      await trial('--min-units', '1'),
      /^advisor #1 rounds 1 first success$/m,
    );
    assert.doesNotMatch(await trial('--min-units', '1'), /thin win/);
    assert.match(await trial('--min-units', '3'), /\(fewer than 3\)$/m);
    await assert.rejects(trial('--min-units', 'x'), CliUsageError);
    await assert.rejects(trial('--min-units'), CliUsageError);
  } finally {
    process.stdout.write = write;
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  }
});

test('--dollars prints both dollar figures, n/a when no merged PR is priced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-cli-'));
  const path = process.env.PATH;
  const write = process.stdout.write;
  try {
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'bin/gh'), '#!/bin/sh\necho "[]"\n');
    await chmod(join(dir, 'bin/gh'), 0o755);
    process.env.PATH = `${join(dir, 'bin')}:${path}`;
    let out = '';
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    await ledgerCommand([
      '--dollars',
      '--root',
      dir,
      '--transcripts',
      dir,
      '--repo',
      'o/r',
    ]);
    process.stdout.write = write;
    assert.match(out, /^Dollars per merged PR: n\/a /m);
    assert.match(out, /^Dollars per first-push-green PR: n\/a /m);
  } finally {
    process.stdout.write = write;
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  }
});
