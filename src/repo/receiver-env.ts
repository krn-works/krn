import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Files by which a receiver root pins its toolchain for mise. */
const PIN_FILES = [
  'mise.toml',
  '.mise.toml',
  'mise.local.toml',
  '.tool-versions',
  join('.config', 'mise.toml'),
  join('mise', 'config.toml'),
] as const;

/** `mise env --json` run in a root with an env: its JSON text, or undefined when mise is missing or refuses. */
export type MiseEnv = (
  root: string,
  env: NodeJS.ProcessEnv,
) => string | undefined;

const miseEnv: MiseEnv = (root, env) => {
  const run = spawnSync('mise', ['env', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 60_000,
  });
  return run.error || run.status !== 0 ? undefined : run.stdout;
};

/** `MISE_<TOOL>_VERSION` overrides a parent set (the KRN launcher pins its own Node this way); they outrank the receiver's own pin. */
const VERSION_OVERRIDE = /^MISE_[A-Z0-9_]+_VERSION$/u;

function withoutOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env))
    if (!VERSION_OVERRIDE.test(name)) kept[name] = value;
  return kept;
}

/**
 * The env a command runs with inside a receiver: the given env with the variables its mise pin
 * resolves (PATH with the pinned tools first), so the receiver's Node runs, never KRN's own.
 * A root with no pin, no mise, or a refusal from mise keeps the env as given.
 */
export function receiverEnv(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  run: MiseEnv = miseEnv,
): NodeJS.ProcessEnv {
  if (!PIN_FILES.some((file) => existsSync(join(root, file)))) return env;
  const base = withoutOverrides(env);
  const text = run(root, base);
  if (text === undefined) return env;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return env;
    throw error;
  }
  if (typeof parsed !== 'object' || parsed === null) return env;
  const resolved: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(parsed))
    if (typeof value === 'string') resolved[name] = value;
  return resolved;
}
