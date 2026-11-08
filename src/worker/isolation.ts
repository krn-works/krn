import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { WorkerError } from './state.ts';

// A worker turn needs neither the operator's MCP servers nor the lead's
// hooks: hooks inject lead context and MCP tool schemas widen every call.
// Codex has no switch for all MCP servers, so each configured name is turned
// off; an unreadable list fails closed rather than starting them.
const features = [
  'apps',
  'browser_use',
  'computer_use',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'plugins',
  'sleep_tool',
  'view_image',
] as const;

// First-call input tokens each switch saved on Codex 0.167 (t-q5cfpv0 probe,
// one source per thread): the skills catalog ~5,400, web search ~2,500,
// goals ~600, the usage instructions ~200. Environment and permission context
// stay; the global AGENTS.md has no switch short of a private CODEX_HOME.
const instructions = {
  'skills.include_instructions': false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_plugin_usage_instructions: false,
  include_skills_usage_instructions: false,
  web_search: 'disabled',
} as const;

type IsolationConfig = Record<string, false | 'disabled'>;

const serversSchema = z
  .array(z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/) }))
  .max(1024);

/** thread/start config overrides from `codex mcp list --json` output. */
export function isolationConfig(mcpList: string): IsolationConfig {
  let names: string[];
  try {
    names = serversSchema.parse(JSON.parse(mcpList)).map(({ name }) => name);
  } catch {
    throw new WorkerError(65, 'invalid Codex MCP server list');
  }
  const config: IsolationConfig = { ...instructions };
  for (const feature of features) config[`features.${feature}`] = false;
  for (const name of [...new Set(names)].sort())
    config[`mcp_servers.${name}.enabled`] = false;
  return config;
}

export function workerIsolation(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): IsolationConfig {
  const listed = spawnSync(executable, ['mcp', 'list', '--json'], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
  });
  if (listed.status !== 0)
    throw new WorkerError(65, 'Codex MCP server list failed');
  return isolationConfig(listed.stdout);
}
