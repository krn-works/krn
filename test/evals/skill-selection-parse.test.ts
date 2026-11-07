import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chosenSkill,
  firstToolCall,
  totalCost,
} from '../../evals/skill-selection/parse.ts';
import prompts from '../../evals/skill-selection/prompts.json' with {
  type: 'json',
};

// Verbatim assistant line captured from claude 2.1.316 stream-json.
const skillLine = String.raw`{"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_011Cgp3b35Dy7VLPdGYwsuSe","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01Ggnq7JR2uANJYnqdEZH18t","name":"Skill","input":{"skill":"krn-handoff"},"caller":{"type":"direct"}}],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":8572,"cache_read_input_tokens":11852,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":8572},"output_tokens":4,"service_tier":"standard","inference_geo":"global","speed":"standard"},"input_transformations":[],"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"a3389656-a77b-4859-910f-380fcebb9203","uuid":"746ccde9-08f9-4924-bcb8-e6f5a80dc119","timestamp":"2026-11-07T18:31:45.030Z","request_id":"req_011Cgp3b2vo1LxM54qYyQGYG","wire_tool_inputs":{"toolu_01Ggnq7JR2uANJYnqdEZH18t":{"skill":"krn-handoff"}}}`;
const resultLine =
  '{"type":"result","subtype":"error_max_turns","total_cost_usd":0.0014863100000000002}';

test('parser reads the first Skill tool call', () => {
  assert.deepEqual(firstToolCall(skillLine), {
    kind: 'skill',
    skill: 'krn-handoff',
  });
  assert.equal(chosenSkill(firstToolCall(skillLine)), 'krn-handoff');
});

test('parser treats other tools, text and junk as no skill', () => {
  const bash = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
  });
  assert.deepEqual(firstToolCall(bash), { kind: 'other-tool', tool: 'Bash' });
  assert.equal(chosenSkill(firstToolCall(bash)), null);
  assert.equal(firstToolCall('not json'), undefined);
  assert.equal(chosenSkill(undefined), null);
});

test('parser reads the result cost', () => {
  assert.equal(totalCost(resultLine), 0.0014863100000000002);
  assert.equal(totalCost(skillLine), undefined);
});

test('prompt set has unique ids and covers a no-skill case', () => {
  assert.equal(new Set(prompts.map((p) => p.id)).size, prompts.length);
  assert.ok(prompts.some((p) => p.expect === null));
});
