import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { postGateStatusWhenClean } from './isolation-gate.mjs';

const ghPath =
  '/home/krn/.local/share/mise/installs/gh/latest/gh_2.101.0_linux_amd64/bin/gh';

function readHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'Unable to read HEAD\n');
    return undefined;
  }
  return result.stdout.trim();
}

function runGate() {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('npm', ['run', 'gate'], {
      env: { ...process.env, KRN_REQUIRE_ZERO_ISOLATION_SKIPS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr
      .setEncoding('utf8')
      .on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', (error) => {
      process.stderr.write(`Unable to start npm run gate: ${error.message}\n`);
      resolve({ exitCode: 1, output: stdout });
    });
    child.once('close', (code) =>
      resolve({ exitCode: code ?? 1, output: stdout }),
    );
  });
}

async function main() {
  const head = readHead();
  if (!head) return 1;
  const gate = await runGate();
  const skipCount = Number(
    gate.output
      .match(/Isolation-dependent tests skipped: (\d+)/gu)
      ?.at(-1)
      ?.match(/\d+$/u)?.[0] ?? Number.NaN,
  );
  const testCount = Number(gate.output.match(/^# tests (\d+)$/mu)?.[1] ?? 0);
  if (!Number.isInteger(skipCount) || !Number.isInteger(testCount)) {
    process.stderr.write(
      'Gate summary was missing; refusing to publish status\n',
    );
    return 1;
  }
  const finalHead = readHead();
  if (finalHead !== head) {
    process.stderr.write(
      'HEAD changed during the local gate; refusing to publish status\n',
    );
    return 1;
  }

  const description = `Gate passed: ${testCount} tests, 0 isolation skips`;
  const posted = await postGateStatusWhenClean({
    exitCode: gate.exitCode,
    skipCount,
    post: async () => {
      const result = spawnSync(
        ghPath,
        [
          'api',
          `repos/krn-works/krn/statuses/${head}`,
          '-f',
          'state=success',
          '-f',
          'context=krn/gate-local',
          '-f',
          `description=${description}`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      if (result.status !== 0) {
        process.stderr.write(
          result.stderr || 'Unable to post gate-local status\n',
        );
        throw new Error('Unable to post gate-local status');
      }
      process.stdout.write(
        `Published krn/gate-local success for ${head}: ${description}\n`,
      );
    },
  });
  if (!posted) {
    process.stderr.write(
      `gate-local did not pass cleanly (exit=${gate.exitCode}, isolation skips=${skipCount}); no status posted\n`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await main();
