import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// PreToolUse hook for Agent: the built-in Explore and Plan agents ignore
// CLAUDE_CODE_SUBAGENT_MODEL and inherit the parent's model, so an Opus lead ran them on
// Opus (22 Explore runs after the variable took effect; reproduced live 2026-11-09, see
// .krn/runs/token-audit/subagent-model-audit.md). When such a call names no model, this
// hook fills in the alias the variable selects. Explicit models are never rerouted or changed; forks are left alone, and
// agents whose definition pins a model get that model written onto the call.
//
// Turn ceiling: general-purpose lanes were 99% of subagent dollars and 15 lanes of 100+
// turns were $167 of $216 (.krn/runs/subagent-spend/report.md). The built-in agent has no
// turn limit, so a general-purpose call without a model is routed to krn-lane, the same worker
// with maxTurns in .claude/agents/krn-lane.md.

const ignoresDefault = new Set(['Explore', 'Plan']);
const laneAgent = 'krn-lane';
const aliases = ['haiku', 'sonnet', 'opus', 'fable'] as const;

export function alias(value: string | undefined) {
  const lower = value?.toLowerCase() ?? '';
  return aliases.find((name) => lower.includes(name));
}

// Model pinned in .claude/agents/<type>.md frontmatter, if any. CLAUDE_CODE_SUBAGENT_MODEL
// beats frontmatter in the receiver (krn-reader pinned haiku ran Sonnet 39 of 55 times,
// .krn/runs/overnight/fable-audit-1114f.md), so the hook sets the model on the call.
export function frontmatterModel(
  agentsDir: string,
  type: string,
): string | undefined {
  if (!/^[\w-]+$/.test(type)) return undefined;
  let text: string;
  try {
    text = readFileSync(join(agentsDir, `${type}.md`), 'utf8');
  } catch {
    return undefined;
  }
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  return /^model:\s*(\S+)\s*$/m.exec(head)?.[1];
}

export function updatedInput(
  payload: unknown,
  configured: string | undefined,
  pinned: (type: string) => string | undefined = () => undefined,
): Record<string, unknown> | undefined {
  const input = (payload as { tool_input?: unknown } | null)?.tool_input;
  if (typeof input !== 'object' || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  if (fields.model !== undefined) return undefined;
  const type = fields.subagent_type;
  if (typeof type !== 'string') return undefined;
  const target = type === 'general-purpose' ? laneAgent : type;
  const model =
    pinned(target) ??
    (ignoresDefault.has(type) ? alias(configured) : undefined);
  if (target === type && !model) return undefined;
  return {
    ...fields,
    subagent_type: target,
    ...(model ? { model } : {}),
  };
}

function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const agentsDir = join(
    process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    '.claude',
    'agents',
  );
  const input = updatedInput(
    payload,
    process.env.CLAUDE_CODE_SUBAGENT_MODEL,
    (type) => frontmatterModel(agentsDir, type),
  );
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
