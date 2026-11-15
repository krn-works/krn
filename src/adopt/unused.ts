// Which project MCP servers and skills no recent session called: read from the transcripts, weighed with the first-turn estimate.

import {
  recentTranscriptFiles,
  transcriptLines,
} from '../harness/transcripts.ts';
import { readJson } from '../repo/json-text.ts';
import { estimateFirstTurn, MCP_SERVER_TOKENS } from './first-turn.ts';

const object = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const string = (v: unknown): string => (typeof v === 'string' ? v : '');
const parse = (v: string): unknown => readJson(v) ?? null;

/** Sessions a tool must have sat unused through before it is reported. */
export const MIN_UNUSED_SESSIONS = 2;
export const DEFAULT_UNUSED_SESSIONS = 5;

export interface UnusedReport {
  /** Transcripts read; the report is empty below MIN_UNUSED_SESSIONS. */
  sessions: number;
  servers: { name: string; tokens: number }[];
  skills: { name: string; tokens: number }[];
  /** Tokens per first turn the listed servers and skills cost. */
  saving: number;
}

/** `mcp__<server>__<tool>` names the server; a Skill call names its skill (a plugin prefix `plugin:` is dropped). */
export function toolUseNames(lines: Iterable<string>): {
  servers: Set<string>;
  skills: Set<string>;
} {
  const servers = new Set<string>();
  const skills = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = object(object(parse(line)).message);
    for (const raw of array(message.content)) {
      const block = object(raw);
      if (block.type !== 'tool_use') continue;
      const name = string(block.name);
      const server = /^mcp__(.+?)__/u.exec(name)?.[1];
      if (server !== undefined) servers.add(server);
      if (name === 'Skill') {
        const skill = string(object(block.input).skill);
        if (skill) skills.add(skill.split(':').at(-1) ?? skill);
      }
    }
  }
  return { servers, skills };
}

export async function unusedTools(
  root: string,
  directories: string[],
  last = DEFAULT_UNUSED_SESSIONS,
): Promise<UnusedReport> {
  const files = await recentTranscriptFiles(directories, last);
  const report: UnusedReport = {
    sessions: files.length,
    servers: [],
    skills: [],
    saving: 0,
  };
  if (files.length < MIN_UNUSED_SESSIONS) return report;
  const usedServers = new Set<string>();
  const usedSkills = new Set<string>();
  for (const file of files) {
    const seen = toolUseNames(await collect(transcriptLines(file.path)));
    for (const name of seen.servers) usedServers.add(name);
    for (const name of seen.skills) usedSkills.add(name);
  }
  const first = estimateFirstTurn(root);
  report.servers = first.mcpServers
    .filter((name) => !usedServers.has(name))
    .map((name) => ({ name, tokens: MCP_SERVER_TOKENS }));
  report.skills = first.skills.filter((skill) => !usedSkills.has(skill.name));
  report.saving = [...report.servers, ...report.skills].reduce(
    (n, t) => n + t.tokens,
    0,
  );
  return report;
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

export function renderUnused(report: UnusedReport): string[] {
  if (report.sessions < MIN_UNUSED_SESSIONS)
    return [
      `unused: ${report.sessions} session(s) read, at least ${MIN_UNUSED_SESSIONS} needed`,
    ];
  const lines = [
    ...report.servers.map(
      (s) =>
        `unused MCP server ${s.name}: 0 calls in ${report.sessions} sessions, ~${s.tokens} tokens per first turn`,
    ),
    ...report.skills.map(
      (s) =>
        `unused skill ${s.name}: 0 calls in ${report.sessions} sessions, ~${s.tokens} tokens per first turn`,
    ),
  ];
  lines.push(
    lines.length === 0
      ? `unused: none in ${report.sessions} sessions`
      : `unused total: ~${report.saving} tokens per first turn (a flat estimate)`,
  );
  return lines;
}
