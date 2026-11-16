import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hookStdin } from '../../src/harness/claude.ts';

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
//
// Lane model: 18 krn-lane calls in one week named `model: opus` and 10 of them had no
// instruction asking for it (.krn/runs/lead/usage/report-before-v3.md, t-ahsmyfp). A lane
// call naming opus or fable runs the lane's pinned model instead, unless its prompt carries a
// `lane-model: opus|fable` line, the explicit opt-in for a measured probe or a hard lane.

const ignoresDefault = new Set(['Explore', 'Plan']);
const laneAgent = 'krn-lane';
const aliases = ['haiku', 'sonnet', 'opus', 'fable'] as const;
const costly = new Set(['opus', 'fable']);

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
  const type = fields.subagent_type;
  if (fields.model !== undefined)
    return laneModel(fields, type, configured, pinned);
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

// An explicit opus or fable on a lane call gives way to the lane's pinned model unless the
// prompt opts in with `lane-model: <alias>`; every other explicit model stays untouched.
function laneModel(
  fields: Record<string, unknown>,
  type: unknown,
  configured: string | undefined,
  pinned: (type: string) => string | undefined,
): Record<string, unknown> | undefined {
  if (type !== laneAgent && type !== 'general-purpose') return undefined;
  const asked = alias(String(fields.model));
  if (!asked || !costly.has(asked)) return undefined;
  const prompt = typeof fields.prompt === 'string' ? fields.prompt : '';
  if (new RegExp(`^lane-model:\\s*${asked}\\b`, 'mi').test(prompt))
    return undefined;
  const model = pinned(laneAgent) ?? alias(configured) ?? 'sonnet';
  return { ...fields, subagent_type: laneAgent, model };
}

// Names a lane rewrite for the operator: asked model, run model and the opt-in line.
export function rewriteNotice(
  payload: unknown,
  input: Record<string, unknown>,
): string | undefined {
  const asked = (payload as { tool_input?: { model?: unknown } } | null)
    ?.tool_input?.model;
  const name = alias(typeof asked === 'string' ? asked : undefined);
  if (!name || !costly.has(name) || input.subagent_type !== laneAgent)
    return undefined;
  if (alias(String(input.model)) === name) return undefined;
  return `krn-lane call asked model ${String(asked)} but runs ${String(input.model)}; add a line "lane-model: ${name}" to the prompt to opt in.`;
}

export function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(hookStdin());
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
  const notice = rewriteNotice(payload, input);
  process.stdout.write(
    `${JSON.stringify({
      ...(notice ? { systemMessage: notice } : {}),
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: input,
      },
    })}\n`,
  );
}
if (import.meta.main) main();
