import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  claudeHooks,
  renderCodex,
  renderSettings,
} from '../../src/dispatch/render.ts';
import { codexEvents, events } from '../../src/dispatch/table.ts';

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('.claude/settings.json hooks and .codex/hooks.json are the table rendered', () => {
  const settings = read('.claude/settings.json');
  assert.equal(renderSettings(settings), settings);
  assert.equal(renderCodex(), read('.codex/hooks.json'));
});

test("every Claude event has exactly one command entry and every Codex event is the table's", () => {
  const hooks = claudeHooks() as Record<string, { hooks: unknown[] }[]>;
  assert.deepEqual(
    Object.keys(hooks).sort(),
    Object.values(events)
      .map((event) => event.claude)
      .sort(),
  );
  for (const groups of Object.values(hooks)) {
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.hooks.length, 1);
  }
  const codex = JSON.parse(read('.codex/hooks.json')).hooks;
  assert.deepEqual(
    Object.keys(codex),
    codexEvents.map((event) => event.event),
  );
});
