import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs scripts/test-suite.mjs on a throwaway project, for the test-suite-*
// test files.
const wrapper = fileURLToPath(
  new URL('../scripts/test-suite.mjs', import.meta.url),
);

export async function fixture() {
  const state = resolve('.krn/tmp');
  await mkdir(state, { recursive: true });
  const root = await mkdtemp(join(state, 'test-suite-'));
  const project = join(root, 'project');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, '.node-version'), process.version.slice(1));
  await writeFile(join(project, 'package.json'), '{"type":"module"}');
  return { root, project };
}

type Outcome = {
  error: Error | undefined;
  status: number | null;
  stdout: string;
  stderr: string;
};

// Non-blocking spawn, so independent runner runs overlap inside one test file.
export function spawnAsync(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<Outcome> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let error: Error | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      error = new Error(`timed out after ${options.timeout ?? 30_000} ms`);
      child.kill('SIGKILL');
    }, options.timeout ?? 30_000);
    child.on('error', (cause) => {
      error = cause;
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      done({ error, status, stdout, stderr });
    });
  });
}

function runnerEnvironment(project: string, extra: NodeJS.ProcessEnv) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST_') || key === 'NODE_OPTIONS') delete env[key];
  }
  delete env.NODE_COMPILE_CACHE;
  delete env.KRN_SCOPE_PROBE;
  delete env.KRN_TEST_STRICT;
  delete env.GITHUB_STEP_SUMMARY;
  return {
    ...env,
    CI: 'true',
    pnpm_config_store_dir: join(project, '.krn/store'),
    ...extra,
  };
}

export function run(
  project: string,
  files: string[],
  extra: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [wrapper, ...files], {
    cwd: project,
    env: runnerEnvironment(project, extra),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

export function runAsync(
  project: string,
  files: string[],
  extra: NodeJS.ProcessEnv = {},
) {
  return spawnAsync([wrapper, ...files], {
    cwd: project,
    env: runnerEnvironment(project, extra),
  });
}

export function passed(result: Outcome) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
