import { readFileSync } from 'node:fs';

// PreToolUse hook for Agent: the built-in Explore and Plan agents ignore
// CLAUDE_CODE_SUBAGENT_MODEL and inherit the parent's model, so an Opus lead ran them on
// Opus (22 Explore runs after the variable took effect; reproduced live 2026-11-09, see
// .krn/runs/token-audit/subagent-model-audit.md). When such a call names no model, this
// hook fills in the alias the variable selects. Explicit models, forks, general-purpose and
// agents whose definition pins a model are left alone.
//
// Turn ceiling: general-purpose lanes were 99% of subagent dollars and 15 lanes of 100+
// turns were $167 of $216 (.krn/runs/subagent-spend/report.md). The built-in agent has no
// turn limit, so an explicit general-purpose call is routed to krn-lane, the same worker
// with maxTurns in .claude/agents/krn-lane.md.

const ignoresDefault = new Set(['Explore', 'Plan']);
const laneAgent = 'krn-lane';
const aliases = ['haiku', 'sonnet', 'opus', 'fable'] as const;

export function alias(value: string | undefined) {
  const lower = value?.toLowerCase() ?? '';
  return aliases.find((name) => lower.includes(name));
}

export function updatedInput(
  payload: unknown,
  configured: string | undefined,
): Record<string, unknown> | undefined {
  const input = (payload as { tool_input?: unknown } | null)?.tool_input;
  if (typeof input !== 'object' || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  if (fields.subagent_type === 'general-purpose')
    return { ...fields, subagent_type: laneAgent };
  if (fields.model !== undefined) return undefined;
  if (
    typeof fields.subagent_type !== 'string' ||
    !ignoresDefault.has(fields.subagent_type)
  )
    return undefined;
  const model = alias(configured);
  return model ? { ...fields, model } : undefined;
}

function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const input = updatedInput(payload, process.env.CLAUDE_CODE_SUBAGENT_MODEL);
  if (!input) return;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: input,
      },
    })}\n`,
  );
}
if (import.meta.main) main();
