// `krn adopt <path> --verify`: an estimate of what the first agent turn loads from the repository.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Tokens per MCP server: its tool schemas are loaded on the first turn; a flat estimate, the real count needs the server. */
const MCP_SERVER_TOKENS = 1500;
const INSTRUCTION_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md'];

export interface FirstTurnReport {
  total: number;
  instructions: { file: string; tokens: number }[];
  skills: { name: string; tokens: number }[];
  mcpServers: string[];
  /** Settings that cut the estimate, each naming the part it applies to. */
  settings: string[];
}

const tokens = (text: string): number => Math.ceil(text.length / 4);

function readIfFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** A skill costs its name and description (the frontmatter) on every turn; the body loads on use. */
function skillHeader(text: string): { header: string; hidden: boolean } {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? '';
  return {
    header: front,
    hidden: /^disable-model-invocation:\s*true\s*$/mu.test(front),
  };
}

function mcpServerNames(root: string): string[] {
  const text = readIfFile(join(root, '.mcp.json'));
  if (text === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    const servers =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { mcpServers?: unknown }).mcpServers
        : undefined;
    return typeof servers === 'object' && servers !== null
      ? Object.keys(servers)
      : [];
  } catch {
    return [];
  }
}

/** Reads the instruction files, project skills and project MCP servers of `root`; changes nothing. */
export function estimateFirstTurn(root: string): FirstTurnReport {
  const instructions: FirstTurnReport['instructions'] = [];
  for (const file of INSTRUCTION_FILES) {
    const text = readIfFile(join(root, file));
    if (text !== undefined) instructions.push({ file, tokens: tokens(text) });
  }
  const skills: FirstTurnReport['skills'] = [];
  const skillDir = join(root, '.claude/skills');
  if (existsSync(skillDir))
    for (const entry of readdirSync(skillDir).sort()) {
      const text = readIfFile(join(skillDir, entry, 'SKILL.md'));
      if (text === undefined) continue;
      const { header, hidden } = skillHeader(text);
      if (!hidden) skills.push({ name: entry, tokens: tokens(header) });
    }
  const mcpServers = mcpServerNames(root);
  const total =
    instructions.reduce((sum, item) => sum + item.tokens, 0) +
    skills.reduce((sum, item) => sum + item.tokens, 0) +
    mcpServers.length * MCP_SERVER_TOKENS;
  const settings: string[] = [];
  if (mcpServers.length > 0)
    settings.push(
      `.claude/settings.json "enabledMcpjsonServers": list only the ${mcpServers.length} MCP server(s) the project needs (each loads ~${MCP_SERVER_TOKENS} tokens of tool schemas)`,
    );
  if (skills.length > 0)
    settings.push(
      `SKILL.md frontmatter "disable-model-invocation: true": a skill used only on request stops costing its description every turn (${skills.length} listed now)`,
    );
  const largest = [...instructions].sort((a, b) => b.tokens - a.tokens)[0];
  if (largest !== undefined && largest.tokens > 2000)
    settings.push(
      `${largest.file} is ~${largest.tokens} tokens on every turn: move reference text to docs/ and keep rules`,
    );
  settings.push(
    '.claude/settings.json "enabledPlugins": set a plugin to false when the project does not use it (plugin skills and agents load on every turn)',
  );
  return { total, instructions, skills, mcpServers, settings };
}

export function renderFirstTurn(report: FirstTurnReport): string[] {
  const parts = [
    `${report.instructions.length} instruction file(s)`,
    `${report.skills.length} skill(s)`,
    `${report.mcpServers.length} MCP server(s)`,
  ];
  return [
    `verify context: first turn ~${report.total} tokens from the repository (${parts.join(', ')}; the host's own prompt, user files and plugins come on top)`,
    ...report.settings.map((setting) => `verify context setting: ${setting}`),
  ];
}
