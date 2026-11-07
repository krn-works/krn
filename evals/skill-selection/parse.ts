// Pure helpers for the skill-selection eval: read claude stream-json lines.
export type Choice =
  | { kind: 'skill'; skill: string }
  | { kind: 'other-tool'; tool: string };

type Block = { type?: string; name?: string; input?: { skill?: unknown } };

/** The first tool call in one stream-json line, or undefined when the line has none. */
export function firstToolCall(line: string): Choice | undefined {
  let event: { type?: string; message?: { content?: unknown } };
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (event.type !== 'assistant' || !Array.isArray(event.message?.content))
    return undefined;
  for (const block of event.message.content as Block[]) {
    if (block.type !== 'tool_use') continue;
    if (block.name === 'Skill' && typeof block.input?.skill === 'string') {
      return { kind: 'skill', skill: block.input.skill };
    }
    return { kind: 'other-tool', tool: String(block.name) };
  }
  return undefined;
}

/** The skill name observed first, null when the model used no skill before acting. */
export function chosenSkill(choice: Choice | undefined): string | null {
  return choice?.kind === 'skill' ? choice.skill : null;
}

export function totalCost(line: string): number | undefined {
  try {
    const event = JSON.parse(line);
    return event.type === 'result' && typeof event.total_cost_usd === 'number'
      ? event.total_cost_usd
      : undefined;
  } catch {
    return undefined;
  }
}
