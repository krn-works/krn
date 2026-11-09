import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { contextTotal } from './context-gauge.ts';
import { object } from './context-io.ts';

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item: unknown) => {
      const block = object(item);
      return block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : JSON.stringify(block);
    })
    .join('');
}

export async function report(path: string) {
  let peakContext = 0;
  let compactions = 0;
  let toolInputChars = 0;
  let toolResultChars = 0;
  let anonymousTurns = 0;
  const messages = new Set<string>();
  const baseline: Record<string, number> = {};
  const tools: Record<string, number> = {};
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = object(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry.isSidechain === true) continue;
    if (entry.type === 'system' && entry.subtype === 'compact_boundary')
      compactions++;
    if (entry.isCompactSummary) continue;
    if (entry.type === 'attachment') {
      const attachment = object(entry.attachment);
      for (const [source, value] of baselineSources(attachment))
        baseline[source] ??= value.length;
      if (Array.isArray(attachment.tools) && !Object.keys(tools).length)
        for (const tool of attachment.tools)
          tools[String(object(tool).name)] = JSON.stringify(tool).length;
      continue;
    }
    if (entry.type !== 'assistant' && entry.type !== 'user') continue;
    try {
      const message = object(entry.message);
      if (entry.type === 'assistant') {
        peakContext = Math.max(peakContext, contextTotal(line) ?? 0);
        if (typeof message.id === 'string') messages.add(message.id);
        else anonymousTurns++;
      }
      if (!Array.isArray(message.content)) continue;
      for (const value of message.content) {
        const block = object(value);
        if (entry.type === 'assistant' && block.type === 'tool_use')
          toolInputChars += JSON.stringify(block.input ?? null).length;
        if (entry.type === 'user' && block.type === 'tool_result')
          toolResultChars += contentText(block.content).length;
      }
    } catch {
      /* Ignore malformed transcript records, as the original report does. */
    }
  }
  return {
    path,
    peakContext,
    assistantTurns: messages.size + anonymousTurns,
    compactions,
    toolResultTokens: Math.round(toolResultChars / 4),
    toolInputTokens: Math.round(toolInputChars / 4),
    baselineTokens: tokens(baseline),
    toolTokens: tokens(tools),
  };
}

/** Prompt sources recorded once at session start; their sizes make up the fresh-session baseline. */
function baselineSources(attachment: Record<string, unknown>) {
  const sources: [string, string][] = [];
  const kind = String(attachment.type);
  if (kind === 'prompt_snapshot') {
    if (attachment.systemPrompt)
      sources.push(['systemPrompt', JSON.stringify(attachment.systemPrompt)]);
    if (Array.isArray(attachment.tools))
      sources.push(['tools', JSON.stringify(attachment.tools)]);
  } else if (
    [
      'skill_listing',
      'agent_listing_delta',
      'instructions',
      'hook_additional_context',
      'deferred_tools_delta',
    ].includes(kind)
  )
    sources.push([kind, JSON.stringify(attachment)]);
  return sources;
}

/** Converts character counts to ~tokens (chars/4), largest first. */
function tokens(chars: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(chars)
      .sort(([, a], [, b]) => b - a)
      .map(([name, size]) => [name, Math.round(size / 4)]),
  );
}

function list(values: Record<string, number>, limit = Infinity) {
  return Object.entries(values)
    .slice(0, limit)
    .map(([name, size]) => `${name} ${size}`)
    .join(', ');
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const paths = args.filter((arg) => arg !== '--json');
    if (!paths.length || paths.some((path) => path.startsWith('--')))
      throw new Error(
        'Usage: context:report -- [--json] <transcript paths or directory>',
      );
    const files = new Set<string>();
    for (const argument of paths) {
      const path = resolve(argument);
      if (statSync(path).isDirectory()) {
        for (const entry of readdirSync(path, {
          recursive: true,
          withFileTypes: true,
        })) {
          if (entry.isFile() && entry.name.endsWith('.jsonl'))
            files.add(join(entry.parentPath, entry.name));
        }
      } else files.add(path);
    }
    const reports = [];
    for (const path of [...files].sort()) reports.push(await report(path));
    process.stdout.write(
      json
        ? `${JSON.stringify(reports, null, 2)}\n`
        : reports
            .map(
              (row) =>
                `${row.path}\npeak main-chain context: ${row.peakContext}; assistant turns: ${row.assistantTurns}; compactions: ${row.compactions}; tool-result tokens (~chars/4): ${row.toolResultTokens}; tool-input tokens (~chars/4): ${row.toolInputTokens}\nbaseline tokens (~chars/4): ${list(row.baselineTokens) || 'none'}\nlargest tools: ${list(row.toolTokens, 8) || 'none'}\n`,
            )
            .join(''),
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
