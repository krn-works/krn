// Git config carried in the environment (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n, GIT_CONFIG_VALUE_n).

const githubHelperKey = 'credential.https://github.com.helper';

/** The entries of GIT_CONFIG_COUNT in order; an absent or malformed count holds none. */
function configEntries(env: NodeJS.ProcessEnv): Array<[string, string]> {
  const count = Number(env.GIT_CONFIG_COUNT);
  const entries: Array<[string, string]> = [];
  if (!Number.isInteger(count) || count <= 0) return entries;
  for (let index = 0; index < count; index += 1) {
    const key = env[`GIT_CONFIG_KEY_${index}`];
    const value = env[`GIT_CONFIG_VALUE_${index}`];
    if (key !== undefined && value !== undefined) entries.push([key, value]);
  }
  return entries;
}

/**
 * The git config variables that give a session the App credential: every
 * inherited entry except a github.com credential helper, then one reset of
 * that helper list and one helper command. Applying it to its own output, at
 * any generation, yields the same variables.
 */
export function appHelperGitConfig(
  env: NodeJS.ProcessEnv,
  helperCommand: string,
): Record<string, string> {
  const entries = configEntries(env).filter(([key]) => key !== githubHelperKey);
  entries.push([githubHelperKey, ''], [githubHelperKey, helperCommand]);
  const config: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    config[`GIT_CONFIG_KEY_${index}`] = key;
    config[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return config;
}

/** True for a name that belongs to the environment git config. */
export function isGitConfigVariable(name: string): boolean {
  return (
    name === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(KEY|VALUE)_\d+$/u.test(name)
  );
}
